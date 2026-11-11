// Generates fileformats/helpers/bifs/BifsTables.js from GPAC's generated tables:
//   src/scenegraph/mpeg4_nodes.c  (per node: field names, event and field types, NDT, quantization info)
//   include/gpac/internal/bifs_tables.h  (per BIFS version: the node data type tables)
// usage: node gen_tables.mjs <gpac dir> <out file>
import fs from "node:fs";
import path from "node:path";

const [gpacDir, outFile] = process.argv.slice(2);
const nodesC = fs.readFileSync(path.join(gpacDir, "mpeg4_nodes.c"), "latin1").replace(/\r/g, "");
const tablesH = fs.readFileSync(path.join(gpacDir, "bifs_tables.h"), "latin1").replace(/\r/g, "");

// The player reads a Switch's choice list as "children" (players/x3d/nodes/GroupingNodes.js).
const RENAME = { Switch: { choice: "children" } };

const EVENT = { GF_SG_EVENT_FIELD: "field", GF_SG_EVENT_EXPOSED_FIELD: "exposedField", GF_SG_EVENT_IN: "eventIn", GF_SG_EVENT_OUT: "eventOut" };
const TYPE = (t) => {
	const m = /^GF_SG_VRML_([SM]F)(\w+)$/.exec(t);
	const names = { BOOL: "Bool", FLOAT: "Float", TIME: "Time", INT32: "Int32", STRING: "String", VEC3F: "Vec3f", VEC2F: "Vec2f", COLOR: "Color",
		ROTATION: "Rotation", IMAGE: "Image", NODE: "Node", VEC4F: "Vec4f", URL: "URL", SCRIPT: "Script", COMMANDBUFFER: "CommandBuffer", ATTRREF: "AttrRef" };
	if (!m || !names[m[2]]) throw new Error("field type " + t);
	return m[1] + names[m[2]];
};
const num = (s) => {
	s = s.trim();
	if (s === "FIX_MAX") return 3.4028235e38;
	if (s === "FIX_MIN") return -3.4028235e38;
	const m = /^FLT2FIX\(\s*([-0-9.e ]+)\)$/.exec(s);
	if (!m) throw new Error("number " + s);
	const v = Number(m[1].replace(/\s/g, ""));
	if (!Number.isFinite(v)) throw new Error("number " + s);
	return v;
};

function body(name, signature) {
	const at = nodesC.indexOf(signature);
	if (at < 0) return null;
	const end = nodesC.indexOf("\n}\n", at);
	return nodesC.slice(at, end);
}
function cases(text) {
	const out = new Map();
	const parts = text.split(/\n\tcase (\d+):\n/);
	for (let i = 1; i < parts.length; i += 2) out.set(Number(parts[i]), parts[i + 1]);
	return out;
}
const list = (name, which) => {
	const m = new RegExp("static const u16 " + name + "_" + which + "2All\\[\\] = \\{([^}]*)\\};").exec(nodesC);
	return m ? m[1].split(",").map((s) => Number(s.trim())) : [];
};

const nodeNames = [...nodesC.matchAll(/\nstatic GF_Err (\w+)_get_field\(GF_Node \*node, GF_FieldInfo \*info\)/g)].map((m) => m[1]);
const NODE_FIELDS = {};
for (const name of nodeNames) {
	const fieldCases = cases(body(name, "\nstatic GF_Err " + name + "_get_field(GF_Node *node, GF_FieldInfo *info)"));
	const aqBody = body(name, "\nstatic Bool " + name + "_get_aq_info(");
	const aq = aqBody ? cases(aqBody) : new Map();
	const dyn = new Set(list(name, "Dyn"));
	const fields = [];
	for (let i = 0; i < fieldCases.size; i++) {
		const text = fieldCases.get(i);
		if (text === undefined) throw new Error(name + " field " + i + " missing");
		const get = (re) => { const m = re.exec(text); return m ? m[1] : null; };
		let fieldName = get(/info->name = "([^"]+)";/);
		fieldName = RENAME[name]?.[fieldName] ?? fieldName;
		const f = { name: fieldName, type: TYPE(get(/info->fieldType = (\w+);/)), event: EVENT[get(/info->eventType = (\w+);/)] };
		if (!f.name || !f.event) throw new Error(name + " field " + i);
		const ndt = get(/info->NDTtype = NDT_(\w+);/);
		if (ndt) f.ndt = ndt;
		if (dyn.has(i)) f.dyn = 1;
		const q = aq.get(i);
		if (q) {
			const g = (re) => { const m = re.exec(q); return m ? m[1] : null; };
			f.quant = Number(g(/\*QType = (\d+);/));
			f.anim = Number(g(/\*AType = (\d+);/));
			const bits = g(/\*QT13_bits = (\d+);/);
			if (bits !== null) f.nbits = Number(bits);
			const lo = g(/\*b_min = ([^;]+);/), hi = g(/\*b_max = ([^;]+);/);
			if (lo !== null) f.min = num(lo);
			if (hi !== null) f.max = num(hi);
		}
		fields.push(f);
	}
	// The coding-mode index tables must be what the event types give, in field order.
	const expect = (which, test) => {
		const want = fields.map((f, i) => (test(f) ? i : -1)).filter((i) => i >= 0);
		const have = list(name, which);
		if (want.join() !== have.join()) throw new Error(name + " " + which + "2All: " + have.join() + " vs " + want.join());
	};
	expect("Def", (f) => f.event === "field" || f.event === "exposedField");
	expect("In", (f) => f.event === "eventIn" || f.event === "exposedField");
	expect("Out", (f) => f.event === "eventOut" || f.event === "exposedField");
	NODE_FIELDS[name] = fields;
}

// NDT tables per version.
const versions = [];
for (const m of tablesH.matchAll(/#define (\w+)_V(\d+)_NUMBITS\s+(\d+)/g)) {
	const [, ndt, v, bits] = m;
	const t = new RegExp("static const u32 " + ndt + "_V" + v + "_TypeToTag\\[\\d+\\] = \\{([^}]*)\\};").exec(tablesH);
	if (!t) throw new Error("no table " + ndt + " V" + v);
	const nodes = t[1].split(",").map((s) => s.trim()).filter(Boolean).map((s) => {
		const name = s.replace(/^TAG_MPEG4_/, "");
		if (!NODE_FIELDS[name]) throw new Error("NDT " + ndt + " names unknown node " + name);
		return name;
	});
	(versions[Number(v) - 1] ??= {})[ndt] = { bits: Number(bits), nodes };
}

const fmtNum = (v) => (Object.is(v, -0) ? "0" : String(v));
let out = "";
out += "// MPEG-4 BIFS decoder tables: every node's fields (wire order) and, per BIFS version, the node data type\n";
out += "// (NDT) tables a node type is coded in.\n";
out += "//\n";
out += "// GENERATED from GPAC's own generated tables (gpac/gpac: src/scenegraph/mpeg4_nodes.c and\n";
out += "// include/gpac/internal/bifs_tables.h, written by its MPEG4Gen from the ISO/IEC 14496-11 node coding tables).\n";
out += "// Do not edit by hand. The one departure: Switch's \"choice\" is named \"children\" (the player reads it so).\n";
out += "//\n";
out += "// A field row: name, type (\"SFFloat\", \"MFNode\", ...), event (\"field\", \"exposedField\", \"eventIn\", \"eventOut\"),\n";
out += "// ndt (the NDT of a node field), dyn (1: animatable, BIFS-Anim), and for a quantizable field quant (the\n";
out += "// quantization category, 0 = none), anim, min, max and nbits (category 13's bit count).\n";
out += "// A field's coding-mode index follows from its event: DEF = field | exposedField, IN = eventIn |\n";
out += "// exposedField, OUT = eventOut | exposedField, each counted in row order.\n\n";
out += "export const NODE_FIELDS = {\n";
for (const [name, fields] of Object.entries(NODE_FIELDS)) {
	out += "\t" + name + ": [\n";
	for (const f of fields) {
		const parts = ["name: \"" + f.name + "\"", "type: \"" + f.type + "\"", "event: \"" + f.event + "\""];
		if (f.ndt) parts.push("ndt: \"" + f.ndt + "\"");
		if (f.dyn) parts.push("dyn: 1");
		if (f.quant !== undefined) {
			parts.push("quant: " + f.quant, "anim: " + f.anim);
			if (f.min !== undefined) parts.push("min: " + fmtNum(f.min));
			if (f.max !== undefined) parts.push("max: " + fmtNum(f.max));
			if (f.nbits !== undefined) parts.push("nbits: " + f.nbits);
		}
		out += "\t\t{ " + parts.join(", ") + " },\n";
	}
	out += "\t],\n";
}
out += "};\n\n";
out += "// NDT[version - 1][ndtName] = { bits, nodes }: a node type of `bits` bits is 1-based into `nodes`; 0 means\n";
out += "// \"the next version's table\". In version 2, type 1 is a PROTO instance and `nodes` starts at type 2.\n";
out += "export const NDT = [\n";
for (const tables of versions) {
	out += "\t{\n";
	for (const [ndt, t] of Object.entries(tables ?? {})) {
		out += "\t\t" + ndt + ": { bits: " + t.bits + ", nodes: [" + t.nodes.map((n) => "\"" + n + "\"").join(", ") + "] },\n";
	}
	out += "\t},\n";
}
out += "];\n";
if (/[^\x00-\x7f]/.test(out)) throw new Error("non-ASCII in output");
fs.writeFileSync(outFile, out);
console.log("nodes", nodeNames.length, "versions", versions.length, "bytes", out.length);
