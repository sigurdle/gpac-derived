// A Script node's SFScript value: the script's fields, then its functions as a coded syntax tree, written
// back out as JavaScript source text. Follows GPAC's src/bifs/script_dec.c (SFScript_Parse and the SFS_*
// readers; the statement and expression codes are src/bifs/script.h's), in its line-broken form.
// Nothing runs the text here.

// script.h: statement types (3 bits) and expression types (6 bits).
const ST_IF = 0, ST_FOR = 1, ST_WHILE = 2, ST_RETURN = 3, ST_COMPOUND_EXPR = 4, ST_BREAK = 5, ST_CONTINUE = 6, ST_SWITCH = 7;

const PREFIX = { 1: "-", 2: "!", 3: "~", 4: "++", 5: "--" };
const POSTFIX = { 6: "++", 7: "--" };
// The script's own operators, written out as coded (29 and 30 are its loose equality tests).
const BINARY = {
	17: "=", 18: "+=", 19: "-=", 20: "*=", 21: "/=", 22: "%=", 23: "&=", 24: "|=", 25: "^=", 26: "<<=", 27: ">>=", 28: ">>>=",
	29: "==", 30: "!=", 31: "<", 32: "<=", 33: ">", 34: ">=", 35: "+", 36: "-", 37: "*", 38: "/", 39: "%",
	40: "&&", 41: "||", 42: "&", 43: "|", 44: "^", 45: "<<", 46: ">>", 47: ">>>",
};
const MAX_EXPRESSION_DEPTH = 500;

// GPAC's gf_get_bit_size: the bits that hold 0..maxValue.
function bitSize(maxValue) {
	let k = 0;
	while (maxValue > Math.pow(2, k) - 1) k++;
	return k;
}

class ScriptReader
{
	constructor(br, identifiers) {
		this.br = br;
		this.identifiers = identifiers;      // names seen so far: the script's fields first
		this.text = "";
		this.indent = 0;
		this.depth = 0;
	}

	add(s) { this.text += s; }
	line() { this.text += "\n"; }
	pad() { this.text += " ".repeat(this.indent); }

	name() {
		let s = "";
		for (let c = this.br.getnbits(8); c !== 0; c = this.br.getnbits(8)) s += String.fromCharCode(c);
		return s;
	}

	identifier() {
		if (this.br.getbit()) {                  // one seen before, by index
			const index = this.br.getnbits(bitSize(this.identifiers.length - 1));
			if (index >= this.identifiers.length) throw new Error("BIFS: script identifier " + index + " out of range");
			this.add(this.identifiers[index]);
		} else {
			const name = this.name();
			this.identifiers.push(name);
			this.add(name);
		}
	}

	args(isVar) {
		if (!isVar) this.add("(");
		let more = this.br.getbit();
		while (more) {
			this.identifier();
			more = this.br.getbit();
			if (more) this.add(",");
		}
		if (!isVar) this.add(")");
	}

	params() {
		let more = this.br.getbit();
		while (more) {
			this.expression();
			more = this.br.getbit();
			if (more) this.add(",");
		}
	}

	statementBlock(functionBody) {
		if (this.br.getbit()) {
			this.add("{");
			this.indent++;
			while (this.br.getbit()) {
				this.line();
				this.pad();
				this.statement();
			}
			this.indent--;
			this.line();
			this.pad();
			this.add("}");
		} else if (functionBody) {
			this.add("{");
			this.statement();
			this.add("}");
		} else {
			this.statement();
		}
	}

	statement() {
		switch (this.br.getnbits(3)) {
			case ST_IF:
				this.add("if (");
				this.compoundExpression();
				this.add(") ");
				this.statementBlock(false);
				if (this.br.getbit()) {
					this.line();
					this.pad();
					this.add("else ");
					this.statementBlock(false);
				}
				break;
			case ST_FOR:
				this.add("for (");
				this.optionalExpression();
				this.add(";");
				this.optionalExpression();
				this.add(";");
				this.optionalExpression();
				this.add(")");
				this.statementBlock(false);
				break;
			case ST_WHILE:
				this.add("while (");
				this.compoundExpression();
				this.add(")");
				this.statementBlock(false);
				break;
			case ST_RETURN:
				this.add("return");
				if (this.br.getbit()) {
					this.add(" ");
					this.compoundExpression();
				}
				this.add(";");
				this.line();
				break;
			case ST_COMPOUND_EXPR:
				this.compoundExpression();
				this.add(";");
				break;
			case ST_BREAK: this.add("break;"); break;
			case ST_CONTINUE: this.add("continue;"); break;
			case ST_SWITCH: {
				this.add("switch (");
				this.compoundExpression();
				this.add("){");
				this.line();
				const bits = this.br.getnbits(5);
				do {
					this.pad();
					this.add("case " + this.br.getnbits(bits) + ":");
					this.line();
					this.pad();
					this.statementBlock(false);
					this.line();
				} while (this.br.getbit());
				if (this.br.getbit()) {
					this.add("default:");
					this.line();
					this.statementBlock(false);
				}
				this.add("}");
				break;
			}
		}
	}

	compoundExpression() {
		this.expression();
		while (this.br.getbit()) {
			this.add(",");
			this.expression();
		}
	}

	optionalExpression() {
		if (this.br.getbit()) this.compoundExpression();
	}

	number() {
		if (this.br.getbit()) {                  // integer
			const bits = this.br.getnbits(5);
			this.add(String(this.br.getnbits(bits) | 0));
			return;
		}
		// real: 4-bit characters, 15 ends
		for (let v = this.br.getnbits(4); v !== 15; v = this.br.getnbits(4)) {
			if (v <= 9) this.add(String(v));
			else if (v === 10) this.add(".");
			else if (v === 11) this.add("E");
			else if (v === 12) this.add("-");
		}
	}

	expression() {
		const type = this.br.getnbits(6);
		if (++this.depth > MAX_EXPRESSION_DEPTH) throw new Error("BIFS: script expression nested too deep");
		if (PREFIX[type] !== undefined) {
			this.add(PREFIX[type]);
			this.expression();
		} else if (POSTFIX[type] !== undefined) {
			this.expression();
			this.add(POSTFIX[type]);
		} else if (BINARY[type] !== undefined) {
			this.expression();
			this.add(BINARY[type]);
			this.expression();
		} else switch (type) {
			case 0:                                // parenthesized
				this.add("(");
				this.compoundExpression();
				this.add(")");
				break;
			case 8:                                // conditional
				this.expression();
				this.add(" ? ");
				this.expression();
				this.add(" : ");
				this.expression();
				break;
			case 9:                                // string
				this.add("'" + this.name() + "'");
				break;
			case 10: this.number(); break;
			case 11: this.identifier(); break;
			case 12:                               // function call
				this.identifier();
				this.add("(");
				this.params();
				this.add(")");
				break;
			case 13:                               // new
				this.add("new ");
				this.identifier();
				this.add("(");
				this.params();
				this.add(") ");
				break;
			case 14:                               // member access
				this.expression();
				this.add(".");
				this.identifier();
				break;
			case 15:                               // method call
				this.expression();
				this.add(".");
				this.identifier();
				this.add("(");
				this.params();
				this.add(")");
				break;
			case 16:                               // array element
				this.expression();
				this.add("[");
				this.compoundExpression();
				this.add("]");
				break;
			case 48: this.add(this.br.getbit() ? "true" : "false"); break;
			case 49:                               // var
				this.add("var ");
				this.args(true);
				break;
			case 50:                               // function expression
				this.add("function ");
				this.args(false);
				this.statementBlock(true);
				break;
			default:
				throw new Error("BIFS: script expression type " + type + " unknown");
		}
		this.depth--;
	}
}

/**
 * Read an SFScript value.
 * @param {import("./BifsBitReader.js").BifsBitReader} br
 * @param {() => string} readScriptField  reads one field declaration (the caller's: it knows the field types and
 *   reads a default value) and returns its name
 * @returns {string} "javascript:" and the functions' source
 */
export function decodeScript(br, readScriptField)
{
	const identifiers = [];
	if (br.getbit()) {                         // list description
		while (!br.getbit()) identifiers.push(readScriptField());
	} else {
		const bits = br.getnbits(4);
		const count = br.getnbits(bits);
		for (let i = 0; i < count; i++) identifiers.push(readScriptField());
	}
	br.getbit();                               // reserved
	const reader = new ScriptReader(br, identifiers);
	reader.add("javascript:");
	reader.line();
	while (br.getbit()) {                      // hasFunction
		reader.add("function ");
		reader.identifier();
		reader.args(false);
		reader.add(" ");
		reader.statementBlock(true);
		reader.line();
	}
	reader.line();
	return reader.text;
}
