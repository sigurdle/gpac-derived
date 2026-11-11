// BIFS scene/command decoder -- turns a BIFS-Command access unit into a
// target-neutral scene tree of plain { type, def, fields, name } nodes (fields
// holds scalars/vectors/strings and child nodes; MF fields are arrays). The tree
// is renderer-agnostic on purpose: players/x3d/X3DTitleNode.js (or anything else) consumes it.
//
// Two sources, kept apart because their licenses differ:
// - Sigurd's own decoder, FirstProject2, which this file started as a port of: BIFSDecoder.cpp
//   ReadBIFSCommandFrame (the 2-bit command loop), BIFSDec.cpp ReadScene / ReadSFNode /
//   ReadMaskNodeDescription / ReadListNodeDescription / ReadField / ReadSFField / ReadMFField and the ReadSF*
//   primitive readers: the SceneReplacement command and the node and field coding.
// - GPAC's src/bifs/ (LGPL 2.1), followed for what was added on 2026-11-11 (#1852): field_decode.c (the
//   QuantizationParameter scope), unquantize.c (quantized values, the efficient float), com_dec.c (update
//   commands, PROTOs, ROUTEs), script_dec.c (BifsScript.js) and memory_decoder.c (a Conditional's buffer,
//   gf_bifs_flush_command_list). The node, field and NDT tables (BifsTables.js) were transcribed from the same
//   C++ until then and are now generated from GPAC's.
// Every command comes out as a plain record; nothing is applied here (see "Command helpers").
//
// Where this departs from GPAC: a QuantizationParameter with isLocal scopes the one sibling after it in a
// vector-coded children list too (GPAC does that for a list-coded one only, and lets it run to the end of a
// vector-coded one -- the outlier against ISO/IEC 14496-11 9.3.7's "the following sibling").
//
// Not decoded (a clear throw rather than a silent mis-decode): the 3D-mesh path, predictive MF fields,
// an XReplace whose target is a field of a child found by index at run time.

import { BifsBitReader } from "./BifsBitReader.js";
import { NODE_FIELDS, NDT } from "./BifsTables.js";
import { decodeScript } from "./BifsScript.js";

// GPAC's gf_get_bit_size: the bits that hold 0..maxValue.
function bitSize(maxValue) {
	let k = 0;
	while (maxValue > Math.pow(2, k) - 1) k++;
	return k;
}

const FLOAT_MAX = 3.4028235e38;

// A node type's fields with their coding-mode lists: DEF = field | exposedField, IN = eventIn |
// exposedField, OUT = eventOut | exposedField, each in field order (GPAC's X_Def2All / In2All / Out2All),
// and the bits an index in each mode takes (gf_get_bit_size(count - 1)).
function codingTable(fields) {
	const def = [], inn = [], out = [];
	for (const f of fields) {
		if (f.event === "field" || f.event === "exposedField") def.push(f);
		if (f.event === "eventIn" || f.event === "exposedField") inn.push(f);
		if (f.event === "eventOut" || f.event === "exposedField") out.push(f);
	}
	return {
		fields, def, in: inn, out,
		defBits: bitSize(Math.max(def.length - 1, 0)), inBits: bitSize(Math.max(inn.length - 1, 0)),
		outBits: bitSize(Math.max(out.length - 1, 0)), allBits: bitSize(Math.max(fields.length - 1, 0)),
	};
}

const NODE_TABLES = new Map();
function nodeTable(typeName) {
	let table = NODE_TABLES.get(typeName);
	if (!table) {
		const fields = NODE_FIELDS[typeName];
		if (!fields) throw new Error(`BIFS: no field table for node '${typeName}'`);
		table = codingTable(fields);
		NODE_TABLES.set(typeName, table);
	}
	return table;
}

// The 6-bit field type of a PROTO interface field and a Script field (GPAC's GF_SG_VRML_* values,
// include/gpac/scenegraph_vrml.h) and their 2-bit event types (GF_SG_EVENT_* / GF_SG_SCRIPT_TYPE_*).
const FIELD_TYPE_CODES = {
	0: "SFBool", 1: "SFFloat", 2: "SFTime", 3: "SFInt32", 4: "SFString", 5: "SFVec3f", 6: "SFVec2f", 7: "SFColor",
	8: "SFRotation", 9: "SFImage", 10: "SFNode", 11: "SFVec4f", 12: "SFURL", 13: "SFScript", 14: "SFCommandBuffer",
	32: "MFBool", 33: "MFFloat", 34: "MFTime", 35: "MFInt32", 36: "MFString", 37: "MFVec3f", 38: "MFVec2f", 39: "MFColor",
	40: "MFRotation", 41: "MFImage", 42: "MFNode", 43: "MFVec4f", 47: "MFURL", 48: "MFScript", 49: "MFCommandBuffer",
};
const PROTO_EVENTS = ["field", "exposedField", "eventIn", "eventOut"];
const SCRIPT_EVENTS = ["field", "eventIn", "eventOut"];

// A coded field type as a field row; a node field of a PROTO or a Script takes any node.
function interfaceField(name, typeCode, event) {
	const type = FIELD_TYPE_CODES[typeCode];
	if (!type || !event) throw new Error(`BIFS: interface field '${name}': field type ${typeCode} unknown`);
	const row = { name, type, event };
	if (type === "SFNode" || type === "MFNode") row.ndt = "SFWorldNode";
	return row;
}

// QuantizationParameter's defaults (GPAC QuantizationParameter_Create, mpeg4_nodes.c).
const QP_DEFAULTS = {
	isLocal: false,
	position3DQuant: false, position3DMin: [-FLOAT_MAX, -FLOAT_MAX, -FLOAT_MAX], position3DMax: [FLOAT_MAX, FLOAT_MAX, FLOAT_MAX], position3DNbBits: 16,
	position2DQuant: false, position2DMin: [-FLOAT_MAX, -FLOAT_MAX], position2DMax: [FLOAT_MAX, FLOAT_MAX], position2DNbBits: 16,
	drawOrderQuant: false, drawOrderMin: -FLOAT_MAX, drawOrderMax: FLOAT_MAX, drawOrderNbBits: 8,
	colorQuant: true, colorMin: 0, colorMax: 1, colorNbBits: 8,
	textureCoordinateQuant: true, textureCoordinateMin: 0, textureCoordinateMax: 1, textureCoordinateNbBits: 16,
	angleQuant: true, angleMin: 0, angleMax: 6.2831853, angleNbBits: 16,
	scaleQuant: false, scaleMin: 0, scaleMax: FLOAT_MAX, scaleNbBits: 8,
	keyQuant: true, keyMin: 0, keyMax: 1, keyNbBits: 8,
	normalQuant: true, normalNbBits: 8,
	sizeQuant: false, sizeMin: 0, sizeMax: FLOAT_MAX, sizeNbBits: 8,
	useEfficientCoding: false,
};

// A command names a node that is not DEF'd (yet): a Conditional's buffer is tried again later.
class UnknownNodeError extends Error {}

const isSF = (type) => type.startsWith("SF");
const mfToSf = (type) => (type.startsWith("MF") ? "SF" + type.slice(2) : type);
const isCoordinate = (typeName) => typeName === "Coordinate" || typeName === "Coordinate2D";

// IEEE-754 reinterpretation (the bits are read MSB-first, i.e. big-endian).
const _f32 = new DataView(new ArrayBuffer(4));
const _f64 = new DataView(new ArrayBuffer(8));
function u32ToFloat(u) { _f32.setUint32(0, u >>> 0); return _f32.getFloat32(0); }
function u64ToDouble(hi, lo) { _f64.setUint32(0, hi >>> 0); _f64.setUint32(4, lo >>> 0); return _f64.getFloat64(0); }

class BifsDecoder
{
	constructor(config) {
		this.config = config;                 // { nodeIDbits, routeIDbits, protoIDbits, use3DmeshCoding, usePredictiveMFField }
		this.defs = new Map();                // the current namespace: nodeID -> { node, table } (for ROUTEs + commands)
		this.routes = [];                     // the last SceneReplacement's routes, as coded
		this.sceneRoot = null;                // the last SceneReplacement's root, as coded
		this.useNames = false;
		this.pendingBuffers = [];             // Conditional buffers not decoded yet: { bytes, value, error }

		// PROTOs: a declaration's body is its own namespace (DEF ids and nested PROTOs).
		this.protoScopes = [new Map()];       // innermost last: protoID -> { id, name, fields, table, ... }
		this.currentProto = null;             // the declaration whose body is being read
		this.protoTables = new WeakMap();     // a declaration -> its interface's coding table
		this.scriptRows = new WeakMap();      // a Script node -> the field rows its script declares

		// Quantization (unquantize.c): the QuantizationParameter in force, those it displaced, the global one
		// (extended update 5), and the point count a coordIndex is sized by (category 14).
		this.globalQP = null;
		this.activeQP = null;
		this.qpStack = [];
		this.storingCoord = false;
		this.coordStored = false;
		this.numCoord = 0;
	}

	// A DEF name (GPAC gf_bifs_dec_name): bytes up to a 0.
	readName(br) {
		let s = "";
		for (let c = br.getnbits(8); c !== 0; c = br.getnbits(8)) s += String.fromCharCode(c);
		return s;
	}

	readSFString(br) {
		const lengthBits = br.getnbits(5);
		const length = br.getnbits(lengthBits);
		let s = "";
		for (let i = 0; i < length; i++) s += String.fromCharCode(br.getnbits(8));
		return s;
	}

	// -- The QuantizationParameter scope (gf_bifs_dec_qp_set / gf_bifs_dec_qp_remove) --
	qpSet(qp) {
		if (this.activeQP && this.activeQP !== this.globalQP) this.qpStack.unshift(this.activeQP);
		this.activeQP = qp;
	}
	qpRemove(activatePrevious) {
		this.activeQP = null;
		if (!activatePrevious) return;
		if (this.qpStack.length) this.activeQP = this.qpStack.shift();
		else if (this.globalQP) this.activeQP = this.globalQP;
	}

	// -- Category 14, a coordIndex: sized by the point count of the Coordinate read before it in the same
	// node (gf_bifs_dec_qp14_*) --
	qp14Enter(enter) {
		if (!this.activeQP) return;
		if (enter) this.storingCoord = true;
		else {
			if (this.storingCoord) this.coordStored = true;
			this.storingCoord = false;
		}
	}
	qp14Reset() {
		this.coordStored = false;
		this.storingCoord = false;
		this.numCoord = 0;
	}
	qp14SetLength(count) {
		if (!this.activeQP || !this.storingCoord || this.coordStored) return;
		this.numCoord = count;
	}
	qp14Bits() {
		if (!this.activeQP || !this.coordStored) return 0;
		return Math.ceil(Math.log1p(this.numCoord) / Math.log(2));
	}

	// -- Floats --
	// The efficient float (gf_bifs_dec_mantissa_float), used for every unquantized float while the
	// QuantizationParameter in force has useEfficientCoding.
	readEfficientFloat(br) {
		const mantLength = br.getnbits(4);
		if (!mantLength) return 0;
		const expLength = br.getnbits(3);
		const mantSign = br.getbit();
		const mantissa = br.getnbits(mantLength - 1);
		let exp = 127;
		if (expLength) {
			const expSign = br.getbit();
			const exponent = br.getnbits(expLength - 1);
			exp += (1 - 2 * expSign) * ((1 << (expLength - 1)) + exponent);
		}
		return u32ToFloat(((mantSign << 31) | ((exp & 0xff) << 23) | (mantissa << 9)) >>> 0);
	}
	readFloat(br) {
		if (this.activeQP && this.activeQP.useEfficientCoding) return this.readEfficientFloat(br);
		return u32ToFloat(br.getnbits(32));
	}

	// -- Quantized values (gf_bifs_dec_unquant_field) --
	// Whether the field's category is on in the QuantizationParameter, with its bits and bounds (Q_IsTypeOn):
	// the field's own bounds narrowed by the parameter's.
	quantRange(qp, category, field) {
		const lo = field.min ?? -FLOAT_MAX, hi = field.max ?? FLOAT_MAX;
		const each = (on, bits, qmin, qmax) => {
			if (!on) return null;
			const at = (v, i) => (Array.isArray(v) ? v[i] : v);
			return { bits, min: [0, 1, 2].map((i) => Math.max(lo, at(qmin, i) ?? lo)), max: [0, 1, 2].map((i) => Math.min(hi, at(qmax, i) ?? hi)) };
		};
		switch (category) {
			case 1: return each(qp.position3DQuant, qp.position3DNbBits, qp.position3DMin, qp.position3DMax);
			case 2: return each(qp.position2DQuant, qp.position2DNbBits, qp.position2DMin, qp.position2DMax);
			case 3: return each(qp.drawOrderQuant, qp.drawOrderNbBits, qp.drawOrderMin, qp.drawOrderMax);
			case 4: return each(qp.colorQuant, qp.colorNbBits, qp.colorMin, qp.colorMax);
			case 5: return each(qp.textureCoordinateQuant, qp.textureCoordinateNbBits, qp.textureCoordinateMin, qp.textureCoordinateMax);
			case 6: return each(qp.angleQuant, qp.angleNbBits, qp.angleMin, qp.angleMax);
			case 7: return each(qp.scaleQuant, qp.scaleNbBits, qp.scaleMin, qp.scaleMax);
			case 8: return each(qp.keyQuant, qp.keyNbBits, qp.keyMin, qp.keyMax);
			case 9: case 10: return qp.normalQuant ? { bits: qp.normalNbBits, min: [0, 0, 0], max: [1, 1, 1] } : null;
			case 11: case 12: return each(qp.sizeQuant, qp.sizeNbBits, qp.sizeMin, qp.sizeMax);
			case 13: return { bits: field.nbits | 0, min: [lo, lo, lo], max: [hi, hi, hi] };     // always on, the field's own bits
			case 14: return { bits: this.qp14Bits(), min: [lo, lo, lo], max: [hi, hi, hi] };    // always on
		}
		return null;
	}

	// Q_InverseQuantize
	inverseQuantize(min, max, bits, value) {
		if (!value) return min;
		if (bits >= 32) return max;
		const top = Math.pow(2, bits) - 1;
		if (value === top) return max;
		return Math.fround(min + (max - min) * value / top);
	}

	// Q_DecCoordOnUnitSphere: a unit vector (2 coded components, a normal) or a unit quaternion (3, a rotation).
	readOnUnitSphere(br, bits, count) {
		if (!bits || bits > 32) throw new Error("BIFS: unit-sphere quantization with " + bits + " bits");
		let dir = 1;
		if (count === 2) dir -= 2 * br.getbit();
		const orient = br.getnbits(2);
		if (orient === 3 && count === 2) throw new Error("BIFS: quantized normal with orientation 3");
		const half = Math.pow(2, bits - 1);
		const tang = [];
		let delta = 1;
		for (let i = 0; i < count; i++) {
			const value = br.getnbits(bits) - half;
			const sign = value >= 0 ? 1 : -1;
			const v = sign * this.inverseQuantize(0, 1, bits - 1, sign * value);
			tang.push(Math.tan(Math.PI / 4 * v));
			delta += tang[i] * tang[i];
		}
		delta = dir / Math.sqrt(delta);
		const out = new Array(count + 1).fill(0);
		out[orient] = delta;
		for (let i = 0; i < count; i++) out[(orient + i + 1) % (count + 1)] = tang[i] * delta;
		return out;
	}

	// The field's value if it is quantized under the QuantizationParameter in force, else undefined.
	readQuantized(br, field, sfType) {
		const qp = this.activeQP;
		const category = field.quant | 0;
		if (!qp || !category) return undefined;
		switch (sfType) {
			case "SFInt32": case "SFFloat": case "SFRotation": case "SFVec2f": case "SFVec3f": case "SFColor": break;
			default: return undefined;
		}
		const range = this.quantRange(qp, category, field);
		if (!range) return undefined;
		const { bits, min, max } = range;
		if (category === 14 && !bits) throw new Error(`BIFS: '${field.name}' is coded before the coordinates that size it`);
		const q = (i) => this.inverseQuantize(min[i], max[i], bits, br.getnbits(bits));
		switch (category) {
			case 13: case 14:
				return (br.getnbits(bits) + Math.trunc(field.min ?? 0)) | 0;
			case 9: {
				if (sfType !== "SFVec3f") throw new Error(`BIFS: normal quantization on '${field.name}' (${sfType})`);
				const v = this.readOnUnitSphere(br, bits, 2);
				const length = Math.hypot(v[0], v[1], v[2]) || 1;
				return [v[0] / length, v[1] / length, v[2] / length];
			}
			case 10: {
				if (sfType !== "SFRotation") throw new Error(`BIFS: rotation quantization on '${field.name}' (${sfType})`);
				const c = this.readOnUnitSphere(br, bits, 3);
				const angle = 2 * Math.acos(c[0]);
				const s = Math.sin(angle / 2);
				if (Math.abs(s) <= 1e-6) return [0, 0, 1, angle];
				return [c[1] / s, c[2] / s, c[3] / s, angle];
			}
		}
		switch (sfType) {                        // Q_DecFloat
			case "SFFloat": return q(0);
			case "SFVec2f": return [q(0), q(1)];
			case "SFVec3f": case "SFColor": return [q(0), q(1), q(2)];
		}
		throw new Error(`BIFS: quantization category ${category} on '${field.name}' (${sfType})`);
	}

	// -- gf_bifs_dec_sf_field -- `node`: the node the field is of (null for a PROTO interface default, which is
	// never quantized).
	readSFField(br, node, field, sfType) {
		if (this.activeQP && node) {
			const v = this.readQuantized(br, field, sfType);
			if (v !== undefined) return v;
		}
		switch (sfType) {
			case "SFBool": return !!br.getbit();
			case "SFInt32": return br.getnbits(32) | 0;
			case "SFFloat": return this.readFloat(br);
			case "SFTime": return u64ToDouble(br.getnbits(32), br.getnbits(32));
			case "SFVec2f": return [this.readFloat(br), this.readFloat(br)];
			case "SFVec3f": case "SFColor": return [this.readFloat(br), this.readFloat(br), this.readFloat(br)];
			case "SFRotation": return [this.readFloat(br), this.readFloat(br), this.readFloat(br), this.readFloat(br)];
			case "SFString": return this.readSFString(br);
			case "SFURL": {
				if (br.getbit()) return { od: br.getnbits(10) };
				return { url: this.readSFString(br) };
			}
			case "SFCommandBuffer": {
				const lengthBits = br.getnbits(5);
				const length = br.getnbits(lengthBits);
				const bytes = new Uint8Array(length);
				for (let i = 0; i < length; i++) bytes[i] = br.getnbits(8);
				// A Conditional's buffer is a command frame. It is decoded when the access unit it
				// came in has been read (resolveCommandBuffers), so that it may name any node of
				// the scene; `commands` is filled in place then, `error` if it does not decode.
				const value = { commands: [], error: null };
				this.pendingBuffers.push({ bytes, value, error: null });
				return value;
			}
			case "SFImage": {                        // 12+12 bit size, 2-bit component count, raw pixels (not byte-aligned)
				const width = br.getnbits(12);
				const height = br.getnbits(12);
				const components = br.getnbits(2) + 1;   // 1 gray, 2 gray+alpha, 3 RGB, 4 RGBA
				const n = components * width * height;
				const pixels = new Uint8Array(n);
				for (let i = 0; i < n; i++) pixels[i] = br.getnbits(8);
				return { width, height, components, pixels };
			}
			case "SFNode": return this.readSFNode(br, field.ndt);
			case "SFScript": {
				if (!node || node.type !== "Script") throw new Error("BIFS: SFScript outside a Script node");
				return decodeScript(br, () => this.readScriptField(br, node));
			}
		}
		throw new Error(`BIFS: field type ${sfType} not supported`);
	}

	// One field declaration of a Script (ParseScriptField): a field's default value goes into the node's
	// fields; the declared rows become the node's `scriptFields` when it is read (readSFNode).
	readScriptField(br, node) {
		const event = SCRIPT_EVENTS[br.getnbits(2)];
		const typeCode = br.getnbits(6);
		const name = this.readName(br);
		const row = interfaceField(name, typeCode, event);
		let rows = this.scriptRows.get(node);
		if (!rows) this.scriptRows.set(node, rows = []);
		rows.push(row);
		if (this.currentProto) {
			if (br.getbit()) {                       // IS: bound to a field of the PROTO being declared
				const protoField = br.getnbits(bitSize(Math.max(this.currentProto.fields.length - 1, 0)));
				(node.is ??= {})[name] = this.protoFieldName(protoField);
				return name;
			}
		}
		if (event === "field" && br.getbit()) {
			const v = this.readField(br, node, row);
			if (v !== undefined) node.fields[name] = v;
		}
		return name;
	}

	protoFieldName(index) {
		const f = this.currentProto.fields[index];
		if (!f) throw new Error(`BIFS: PROTO '${this.currentProto.name}' has no field ${index}`);
		return f.name;
	}

	// -- BD_DecMFFieldList / BD_DecMFFieldVec -- A QuantizationParameter in a children list is in force for
	// the siblings after it and what they hold; with isLocal, for the one sibling after it. The node stays in
	// the list.
	readMFField(br, node, field, isList) {
		const sfType = mfToSf(field.type);
		const out = [];
		const hadQP = this.activeQP !== null;
		let qpOn = false, qpLocal = 0;
		const readOne = () => {
			if (sfType !== "SFNode") {
				out.push(this.readSFField(br, node, field, sfType));
				return true;
			}
			const child = this.readSFNode(br, field.ndt);
			if (child === null) return false;        // a NULL node ends the list (GPAC)
			const real = child.use !== undefined ? this.defs.get(child.use)?.node : child;
			if (node && real && real.type === "QuantizationParameter") {
				if (qpOn) this.qpRemove(false);
				this.qpSet({ ...QP_DEFAULTS, ...real.fields });
				qpOn = true;
				qpLocal = real.fields.isLocal ? 2 : 0;
			}
			out.push(child);
			return true;
		};
		const afterOne = () => {
			if (!qpOn || !qpLocal) return;
			if (qpLocal === 2) qpLocal = 1;          // the parameter itself was just read
			else {
				this.qpRemove(hadQP);
				qpLocal = 0;
				qpOn = false;
			}
		};
		if (isList) {
			let count = 0;
			while (!br.getbit()) {
				if (!readOne()) break;
				afterOne();
				count++;
			}
			if (qpOn) this.qpRemove(hadQP);
			this.qp14SetLength(count);
		} else {
			const nBits = br.getnbits(5);
			const n = br.getnbits(nBits);
			this.qp14SetLength(n);
			for (let i = 0; i < n; i++) {
				if (!readOne()) throw new Error(`BIFS: NULL node in the vector-coded '${field.name}'`);
				afterOne();
			}
			if (qpOn) this.qpRemove(hadQP);
		}
		return out;
	}

	// -- gf_bifs_dec_field -- undefined when an MF field's reserved bit says nothing is coded (the field keeps
	// what it had).
	readField(br, node, field) {
		if (isSF(field.type)) return this.readSFField(br, node, field, field.type);
		if (this.config.usePredictiveMFField && br.getbit()) {
			throw new Error(`BIFS: predictive MF field coding ('${field.name}') not supported`);
		}
		if (br.getbit()) return undefined;         // reserved
		return this.readMFField(br, node, field, !!br.getbit());
	}

	// -- gf_bifs_dec_node_mask -- Inside a PROTO declaration every field has a bit (not only the DEF-mode
	// ones) and may be IS-bound to a field of the PROTO.
	readNodeMask(br, node, table) {
		if (this.currentProto) {
			const protoBits = bitSize(Math.max(this.currentProto.fields.length - 1, 0));
			for (const field of table.fields) {
				if (!br.getbit()) continue;
				if (br.getbit()) (node.is ??= {})[field.name] = this.protoFieldName(br.getnbits(protoBits));
				else this.setField(node, field, this.readField(br, node, field));
			}
			return;
		}
		for (const field of table.def) {
			if (br.getbit()) this.setField(node, field, this.readField(br, node, field));
		}
	}

	// -- gf_bifs_dec_node_list --
	readNodeList(br, node, table) {
		const protoBits = this.currentProto ? bitSize(Math.max(this.currentProto.fields.length - 1, 0)) : 0;
		const { allBits, defBits } = table;
		while (!br.getbit()) {                   // 0 = a field follows, 1 = end of fields
			if (this.currentProto && br.getbit()) {  // IS
				const field = table.fields[br.getnbits(allBits)];
				const protoField = br.getnbits(protoBits);
				if (!field) throw new Error(`BIFS: IS field out of range on '${node.type}'`);
				(node.is ??= {})[field.name] = this.protoFieldName(protoField);
				continue;
			}
			const fieldRef = br.getnbits(defBits);
			const field = table.def[fieldRef];
			if (!field) throw new Error(`BIFS: DEF field ref ${fieldRef} out of range on '${node.type}'`);
			this.setField(node, field, this.readField(br, node, field));
		}
	}

	setField(node, field, value) {
		if (value !== undefined) node.fields[field.name] = value;
	}

	findProto(id) {
		for (let i = this.protoScopes.length - 1; i >= 0; i--) {
			const proto = this.protoScopes[i].get(id);
			if (proto) return proto;
		}
		return null;
	}

	// -- gf_bifs_dec_node -- null for the NULL node (a USE of the all-ones id). A PROTO instance is
	// { type: the PROTO's name, proto: its id, fields: its interface fields }.
	readSFNode(br, ndtName) {
		const idBits = this.config.nodeIDbits;
		if (br.getbit()) {                       // USE
			const nodeID = br.getnbits(idBits);
			if (nodeID === Math.pow(2, idBits) - 1) return null;
			const used = this.defs.get(nodeID)?.node;
			if (used && isCoordinate(used.type)) {   // its point count sizes a coordIndex after it
				this.qp14Enter(true);
				this.qp14SetLength(Array.isArray(used.fields.point) ? used.fields.point.length : 0);
				this.qp14Enter(false);
			}
			return { use: nodeID };
		}

		// The node type: per BIFS version, 0 = "in the next version's table".
		let version = 1, localType = 0;
		for (;;) {
			const bits = NDT[version - 1]?.[ndtName]?.bits ?? 0;
			// A scene with no top node (only an EXTERNPROTO) ends here.
			if (version === 1 && bits > br.bytes.length * 8 - br.bitsConsumed()) return null;
			localType = bits ? br.getnbits(bits) : 0;
			if (localType) break;
			if (++version > NDT.length) throw new Error(`BIFS: node type beyond BIFS version ${NDT.length} (NDT ${ndtName})`);
		}
		let proto = null, typeName = null;
		if (version === 2 && localType === 1) {
			const protoID = br.getnbits(this.config.protoIDbits);
			proto = this.findProto(protoID);
			if (!proto) throw new Error(`BIFS: instance of PROTO ${protoID} which is not declared`);
		} else {
			typeName = NDT[version - 1][ndtName].nodes[localType - (version === 2 ? 2 : 1)];
			if (!typeName) throw new Error(`BIFS: node type ${localType} out of range (NDT ${ndtName}, version ${version})`);
			if (typeName === "IndexedFaceSet" && this.config.use3DmeshCoding) throw new Error("BIFS: 3D mesh coding not supported");
		}

		const node = proto ? { type: proto.name, proto: proto.id, fields: {} } : { type: typeName, fields: {} };
		const table = proto ? this.protoTables.get(proto) : nodeTable(typeName);
		if (!table) throw new Error(`BIFS: instance of PROTO '${proto.name}' inside its own declaration`);
		let nodeID = -1;
		if (br.getbit()) {                       // DEF
			nodeID = node.def = br.getnbits(idBits);
			if (this.useNames) node.name = this.readName(br);
		}

		const resetQp14 = !this.coordStored;
		if (typeName !== null && isCoordinate(typeName)) this.qp14Enter(true);
		if (br.getbit()) this.readNodeMask(br, node, table);
		else this.readNodeList(br, node, table);
		if (this.coordStored && resetQp14) this.qp14Reset();
		if (typeName !== null && isCoordinate(typeName)) this.qp14Enter(false);

		// A Script's own fields follow its three in every coding mode (GPAC gf_sg_script_field_new).
		const scriptRows = this.scriptRows.get(node);
		if (scriptRows) node.scriptFields = scriptRows.map((row) => ({ name: row.name, type: row.type, event: row.event }));
		if (nodeID >= 0) {
			this.defs.set(nodeID, { node, table: scriptRows ? codingTable([...table.fields, ...scriptRows]) : table });
		}
		return node;
	}

	// The two ends of a ROUTE (shared by a ROUTE and a ROUTEReplacement).
	readRouteEnds(br) {
		const fromNode = br.getnbits(this.config.nodeIDbits);
		const outDef = this.defs.get(fromNode);
		if (!outDef) throw new UnknownNodeError(`BIFS: ROUTE from undefined node ${fromNode}`);
		const outRef = br.getnbits(outDef.table.outBits);

		const toNode = br.getnbits(this.config.nodeIDbits);
		const inDef = this.defs.get(toNode);
		if (!inDef) throw new UnknownNodeError(`BIFS: ROUTE to undefined node ${toNode}`);
		const inRef = br.getnbits(inDef.table.inBits);

		return {
			fromNode, fromField: outDef.table.out[outRef]?.name ?? outRef,
			toNode,   toField:   inDef.table.in[inRef]?.name ?? inRef,
		};
	}

	// -- gf_bifs_dec_route -- `id` is the ROUTE's own id (a ROUTEDeletion / ROUTEReplacement names it),
	// null for a route without one.
	readRoute(br) {
		let id = null, name = null;
		if (br.getbit()) {                       // isUpdateable -> ROUTE id (+ name)
			id = br.getnbits(this.config.routeIDbits);
			if (this.useNames) name = this.readName(br);
		}
		return { id, name, ...this.readRouteEnds(br) };
	}

	readRoutes(br) {
		const routes = [];
		if (!br.getbit()) return routes;           // hasROUTEs
		if (br.getbit()) {                         // list description
			do { routes.push(this.readRoute(br)); } while (br.getbit());
		} else {                                   // vector description
			const nBits = br.getnbits(5);
			const length = br.getnbits(nBits);
			for (let i = 0; i < length; i++) routes.push(this.readRoute(br));
		}
		return routes;
	}

	// -- gf_bifs_dec_proto_list -- PROTO declarations: { id, name, fields, externUrl, protos, nodes, routes }.
	// `fields` are field rows (name, type, event, and quant / nbits / min / max when the declaration gives
	// quantization) with `value`, a field's default; `nodes` is the body, the first node the one an instance
	// stands for; a body node's `is` maps its field names to the PROTO's. The body is its own namespace.
	readProtoList(br) {
		const list = [];
		const outerProto = this.currentProto;
		try {
			while (br.getbit()) {
				if (!this.config.protoIDbits) throw new Error("BIFS: PROTO declaration in a stream without PROTO ids");
				const scope = this.protoScopes[this.protoScopes.length - 1];
				const id = br.getnbits(this.config.protoIDbits);
				const name = this.useNames ? this.readName(br) : "Proto" + scope.size;
				const proto = { id, name, fields: [], externUrl: null, protos: [], nodes: [], routes: [] };
				scope.set(id, proto);
				list.push(proto);
				this.currentProto = proto;
				// The declaration is its own namespace, from the interface's default values on.
				const outerDefs = this.defs, outerBuffers = this.pendingBuffers;
				this.defs = new Map();
				this.pendingBuffers = [];
				this.protoScopes.push(new Map());
				try {

				// 1: the interface
				while (br.getbit()) {
					const event = PROTO_EVENTS[br.getnbits(2)];
					const typeCode = br.getnbits(6);
					const fieldName = this.useNames ? this.readName(br) : "_field" + proto.fields.length;
					const row = interfaceField(fieldName, typeCode, event);
					proto.fields.push(row);
					if (event === "field" || event === "exposedField") {
						if (isSF(row.type)) row.value = this.readSFField(br, null, row, row.type);
						else {
							if (this.config.usePredictiveMFField && br.getbit()) throw new Error("BIFS: PROTO field default with predictive coding");
							if (!br.getbit()) row.value = this.readMFField(br, null, row, !!br.getbit());
						}
					}
				}

				// 2: the body
				if (br.getbit()) {                       // EXTERNPROTO: its URLs
					if (this.config.usePredictiveMFField && br.getbit()) throw new Error("BIFS: EXTERNPROTO url with predictive coding");
					br.getbit();                           // reserved
					proto.externUrl = this.readMFField(br, null, { name: "ExternProto", type: "MFURL" }, !!br.getbit());
				} else {
					proto.protos = this.readProtoList(br);
					this.currentProto = proto;
					do {
						const node = this.readSFNode(br, "SFWorldNode");
						if (node !== null) {
							proto.nodes.push(node);
							this.resolveCommandBuffers();          // against the body's namespace
						}
					} while (br.getbit());
					this.resolveCommandBuffers(true);
					proto.routes = this.readRoutes(br);
				}

				} finally {
					this.protoScopes.pop();
					this.defs = outerDefs;
					this.pendingBuffers = outerBuffers;
				}

				// 3: quantization and animation of the interface fields
				const useQuant = br.getbit(), useAnim = br.getbit();
				for (const row of proto.fields) {
					const coded = row.event === "field" || row.event === "exposedField";
					if (useQuant && coded) {
						const category = br.getnbits(4);
						let nbits = 0;
						if (category === 13) nbits = br.getnbits(5);
						let min, max;
						if (br.getbit()) {                   // hasMinMax
							const sf = mfToSf(row.type);
							const boundType = sf === "SFInt32" || sf === "SFTime" ? sf : "SFFloat";
							min = this.readSFField(br, null, row, boundType);
							max = this.readSFField(br, null, row, boundType);
						}
						if (category) {
							row.quant = category;
							if (category === 13) row.nbits = nbits;
							if (min !== undefined) { row.min = min; row.max = max; }
						}
					}
					if (useAnim && (row.event === "eventIn" || row.event === "exposedField")) {
						if (br.getbit()) br.getnbits(4);     // the animation category (BIFS-Anim)
					}
				}
				this.protoTables.set(proto, codingTable(proto.fields));
			}
		} finally {
			this.currentProto = outerProto;
		}
		return list;
	}

	// -- BD_DecSceneReplace -- { root, routes, protos }; root is null for a scene with no top node.
	readScene(br) {
		br.getnbits(6);                          // reserved
		this.useNames = !!br.getbit();
		const protos = this.readProtoList(br);
		const root = this.readSFNode(br, "SFTopNode");
		const routes = this.readRoutes(br);
		return { root, routes, protos };
	}

	// -- Command helpers --
	// A command is decoded into a plain record and NOT applied here: the runtime
	// (players/x3d/X3DScene.js applyCommand) applies it to the live scene at its time. The
	// decoder keeps only what decoding needs: the DEF table (node id -> field table and index
	// bit widths). A deleted node's entry stays: a Conditional's buffer is decoded once, at
	// load, and may name a node a later access unit deletes.
	//
	// Record shapes (`node` / `id` are the coded ids, as a node's `def`; `position` is an
	// index, 0 = first, -1 = last / append, as GPAC's):
	//   NodeInsertion              { node, position, child }           into node.children
	//   IndexedValueInsertion      { node, field, position, value }
	//   ROUTEInsertion             { route }
	//   NodeDeletion               { node }                            every instance of it
	//   IndexedValueDeletion       { node, field, position }
	//   ROUTEDeletion              { route: id }
	//   NodeReplacement            { node, newNode }                   every instance of it
	//   FieldReplacement           { node, field, value }
	//   IndexedValueReplacement    { node, field, position, value }
	//   ROUTEReplacement           { id, route }
	//   SceneReplacement           { scene: { root, routes, protos } }
	//   MultipleReplacement        { node, fields: { name: value } }   (extended update 4)
	//   MultipleIndexedReplacement { node, field, items: [{ position, value }] }   (extended update 3)
	//   GlobalQuantizer            { }                                 (extended 5: decoder state only)
	//   ProtoInsertion             { protos }                          (extended 0)
	//   ProtoDeletion              { protos: [id] } or { all: true }   (extended 1, 2)
	//   XReplace                   { node, field, position?, positionFrom?, childField?, from?, value? }   (extended 7):
	//                              the field, or its element at `position` (or at the number in the field
	//                              positionFrom: { node, field }), or with `childField` that field of the child at
	//                              `position`, takes `value` or a copy of the field from: { node, field }
	// Extended update 6 (NodeDeleteEx) is a NodeDeletion record with removeOrder: true (an OrderedGroup
	// the node leaves loses the matching `order` entry).

	requireDef(id, what) {
		const def = this.defs.get(id);
		if (!def) throw new UnknownNodeError(`BIFS: ${what} references node ${id} which is not DEF'd`);
		return def;
	}
	// A command's node and eventIn-indexed field: nodeID, then inID.
	readTargetField(br, what) {
		const node = br.getnbits(this.config.nodeIDbits);
		const def = this.requireDef(node, what);
		const inID = br.getnbits(def.table.inBits);
		const field = def.table.in[inID];
		if (!field) throw new Error(`BIFS: ${what} on node ${node} (${def.node.type}): bad inID ${inID}`);
		return { node, def, field };
	}
	// A node and one of its DEF-mode fields: nodeID, then defID.
	readSourceField(br, what) {
		const node = br.getnbits(this.config.nodeIDbits);
		const def = this.requireDef(node, what);
		const field = def.table.def[br.getnbits(def.table.defBits)];
		if (!field) throw new Error(`BIFS: ${what} on node ${node} (${def.node.type}): bad defID`);
		return { node, field: field.name };
	}
	// bit(2): 0 = an index of `bits` bits follows, 2 = first, 3 = last.
	readPosition(br, bits) {
		const pos = br.getnbits(2);
		if (pos === 0) return br.getnbits(bits);
		if (pos === 2) return 0;
		if (pos === 3) return -1;
		throw new Error("BIFS: position type 1 reserved");
	}
	// One element of an MF field (a node for an MFNode field).
	readElement(br, def, field) {
		return this.readSFField(br, def.node, field, mfToSf(field.type));
	}
	// A command's whole field value.
	readFieldValue(br, def, field, what) {
		const value = this.readField(br, def.node, field);
		if (value === undefined) throw new Error(`BIFS: ${what}: '${field.name}' coded with the reserved bit set`);
		return value;
	}
	requireMF(field, what) {
		if (isSF(field.type)) throw new Error(`BIFS: ${what} on SF field '${field.name}'`);
	}

	// -- InsertionCommand (9.3.6.4; GPAC BD_DecInsert) --
	readInsertion(br) {
		const pt = br.getnbits(2);
		if (pt === 0) {                          // NodeInsertion (9.3.6.5)
			const id = br.getnbits(this.config.nodeIDbits);
			const def = this.requireDef(id, "NodeInsertion");
			const children = def.table.fields.find((f) => f.name === "children");
			if (!children || !children.ndt) throw new Error(`BIFS: NodeInsertion into node ${id} which has no children field`);
			const position = this.readPosition(br, 8);
			const child = this.readSFNode(br, children.ndt);
			return { type: "NodeInsertion", node: id, position, child };
		}
		if (pt === 1) return this.readExtendedUpdate(br);
		if (pt === 2) {                          // IndexedValueInsertion (9.3.6.6)
			const { node, def, field } = this.readTargetField(br, "IndexedValueInsertion");
			const position = this.readPosition(br, 16);
			this.requireMF(field, "IndexedValueInsertion");
			const value = this.readElement(br, def, field);
			return { type: "IndexedValueInsertion", node, field: field.name, position, value };
		}
		return { type: "ROUTEInsertion", route: this.readRoute(br) };   // 9.3.6.7 = same body as a ROUTE
	}

	// -- Extended updates (GPAC BD_DecExtendedUpdate) --
	readExtendedUpdate(br) {
		const type = br.getnbits(8);
		switch (type) {
			case 0:                                // PROTO list
				return { type: "ProtoInsertion", protos: this.readProtoList(br) };
			case 1: {                              // PROTO deletion (BD_DecProtoDelete)
				const protos = [];
				if (br.getbit()) {
					while (br.getbit()) protos.push(br.getnbits(this.config.protoIDbits));
				} else {
					const bits = br.getnbits(5);
					const count = br.getnbits(bits);
					for (let i = 0; i < count; i++) protos.push(br.getnbits(this.config.protoIDbits));
				}
				for (const id of protos) this.protoScopes[this.protoScopes.length - 1].delete(id);
				return { type: "ProtoDeletion", protos };
			}
			case 2:                                // all PROTOs deleted
				this.protoScopes[this.protoScopes.length - 1].clear();
				return { type: "ProtoDeletion", all: true };
			case 3: {                              // MultipleIndexedReplacement (BD_DecMultipleIndexReplace)
				const { node, def, field } = this.readTargetField(br, "MultipleIndexedReplacement");
				this.requireMF(field, "MultipleIndexedReplacement");
				const posBits = br.getnbits(5);
				const countBits = br.getnbits(5);
				const count = br.getnbits(countBits);
				const items = [];
				for (let i = 0; i < count; i++) {
					const position = br.getnbits(posBits);
					items.push({ position, value: this.readElement(br, def, field) });
				}
				return { type: "MultipleIndexedReplacement", node, field: field.name, items };
			}
			case 4: {                              // MultipleReplacement (BD_DecMultipleReplace): a node description's fields
				const id = br.getnbits(this.config.nodeIDbits);
				const def = this.requireDef(id, "MultipleReplacement");
				const holder = { type: def.node.type, fields: {} };
				if (br.getbit()) this.readNodeMask(br, holder, def.table);
				else this.readNodeList(br, holder, def.table);
				return { type: "MultipleReplacement", node: id, fields: holder.fields };
			}
			case 5: {                              // GlobalQuantizer (BD_DecGlobalQuantizer)
				const node = this.readSFNode(br, "SFWorldNode");
				this.globalQP = null;
				this.activeQP = null;
				if (node && node.type === "QuantizationParameter") {
					this.globalQP = { ...QP_DEFAULTS, ...node.fields, isLocal: false };
					this.activeQP = this.globalQP;
				}
				return { type: "GlobalQuantizer" };
			}
			case 6:                                // NodeDeleteEx (BD_DecNodeDeleteEx)
				return { type: "NodeDeletion", node: br.getnbits(this.config.nodeIDbits), removeOrder: true };
			case 7:
				return this.readXReplace(br);
		}
		throw new Error(`BIFS: extended update ${type} unknown`);
	}

	// -- XReplace (BD_XReplace) --
	readXReplace(br) {
		const target = this.readTargetField(br, "XReplace");
		const record = { type: "XReplace", node: target.node, field: target.field.name };
		let { def, field } = target;
		let indexed = false;
		if (!isSF(field.type)) {
			if (br.getbit()) {                       // an element of the field
				if (br.getbit()) {                     // at the number a field holds
					record.positionFrom = this.readSourceField(br, "XReplace");
					indexed = true;
				} else {
					const kind = br.getnbits(2);
					if (kind === 0) { record.position = br.getnbits(16); indexed = true; }
					else if (kind === 2) { record.position = 0; indexed = true; }
					else if (kind === 3) { record.position = -1; indexed = true; }
				}
			}
			if (field.type === "MFNode" && br.getbit()) {   // a field of the child at that position
				// The child's type sizes the field index: it is looked up in the node as coded, so a
				// position that only the running scene knows cannot be decoded ahead of time.
				const list = def.node.fields[field.name];
				let child = Array.isArray(list) && record.position !== undefined ? list[record.position < 0 ? list.length - 1 : record.position] : null;
				if (child && child.use !== undefined) child = this.defs.get(child.use)?.node;
				if (!child) throw new Error("BIFS: XReplace of a child's field: the child is not known ahead of the running scene");
				const childProto = child.proto !== undefined ? this.findProto(child.proto) : null;
				const childTable = child.proto !== undefined ? (childProto ? this.protoTables.get(childProto) : null) : nodeTable(child.type);
				if (!childTable) throw new Error("BIFS: XReplace of a field of an undeclared PROTO's instance");
				field = childTable.in[br.getnbits(childTable.inBits)];
				if (!field) throw new Error("BIFS: XReplace: bad inID on the child");
				def = { node: child, table: childTable };
				record.childField = field.name;
				indexed = false;
			}
		}
		if (br.getbit()) {                         // the value is another field's
			record.from = this.readSourceField(br, "XReplace");
			return record;
		}
		record.value = indexed ? this.readElement(br, def, field) : this.readFieldValue(br, def, field, "XReplace");
		return record;
	}

	// -- DeletionCommand (9.3.6.8; GPAC BD_DecDelete) --
	readDeletion(br) {
		const pt = br.getnbits(2);
		if (pt === 0) {                          // NodeDeletion (9.3.6.9)
			return { type: "NodeDeletion", node: br.getnbits(this.config.nodeIDbits) };
		}
		if (pt === 2) {                          // IndexedValueDeletion (9.3.6.10) -- no value, just position
			const id = br.getnbits(this.config.nodeIDbits);
			const def = this.requireDef(id, "IndexedValueDeletion");
			const inID = br.getnbits(def.table.inBits);
			const position = this.readPosition(br, 16);
			const field = def.table.in[inID];
			if (!field) throw new Error(`BIFS: IndexedValueDeletion on node ${id}: bad inID`);
			this.requireMF(field, "IndexedValueDeletion");
			return { type: "IndexedValueDeletion", node: id, field: field.name, position };
		}
		if (pt === 3) {                          // ROUTEDeletion (9.3.6.11)
			return { type: "ROUTEDeletion", route: br.getnbits(this.config.routeIDbits) };
		}
		throw new Error(`BIFS: DeletionCommand parameterType ${pt} reserved`);
	}

	// -- ReplacementCommand (9.3.6.12; GPAC BD_DecReplace) --
	readReplacement(br) {
		const pt = br.getnbits(2);
		if (pt === 0) {                          // NodeReplacement (9.3.6.13): the new node is coded in SFWorldNode
			const id = br.getnbits(this.config.nodeIDbits);
			this.requireDef(id, "NodeReplacement");
			const newNode = this.readSFNode(br, "SFWorldNode");
			return { type: "NodeReplacement", node: id, newNode };
		}
		if (pt === 1) {                          // FieldReplacement (9.3.6.14)
			const { node, def, field } = this.readTargetField(br, "FieldReplacement");
			const value = this.readFieldValue(br, def, field, "FieldReplacement");
			return { type: "FieldReplacement", node, field: field.name, value };
		}
		if (pt === 2) {                          // IndexedValueReplacement (9.3.6.15)
			const { node, def, field } = this.readTargetField(br, "IndexedValueReplacement");
			this.requireMF(field, "IndexedValueReplacement");
			const position = this.readPosition(br, 16);
			const value = this.readElement(br, def, field);
			return { type: "IndexedValueReplacement", node, field: field.name, position, value };
		}
		// ROUTEReplacement (9.3.6.16): the ROUTE's id, then its new ends
		const id = br.getnbits(this.config.routeIDbits);
		return { type: "ROUTEReplacement", id, route: { id, name: null, ...this.readRouteEnds(br) } };
	}

	// -- gf_bifs_dec_command -- the commands go into `commands` as they are read, so a frame that
	// fails partway keeps what it had.
	// `inBuffer`: a Conditional's buffer -- a SceneReplacement in it does not reset the DEF
	// table (the buffers of the scene it sits in are still being decoded against it).
	readCommandFrame(br, commands = [], inBuffer = false) {
		this.activeQP = this.globalQP;
		this.qpStack.length = 0;
		this.qp14Reset();
		let cont;
		do {
			const code = br.getnbits(2);
			switch (code) {
				case 0: commands.push(this.readInsertion(br)); break;
				case 1: commands.push(this.readDeletion(br)); break;
				case 2: commands.push(this.readReplacement(br)); break;
				case 3: {                            // SceneReplacement -- replaces the whole scene
					if (!inBuffer) {
						this.defs.clear();
						this.protoScopes = [new Map()];
						this.globalQP = null;
						this.activeQP = null;
					}
					const useNames = this.useNames;
					const scene = this.readScene(br);
					if (inBuffer) this.useNames = useNames;   // a buffer's scene does not change how the stream is read
					if (!inBuffer) {
						this.sceneRoot = scene.root;
						this.routes = scene.routes;
					}
					commands.push({ type: "SceneReplacement", scene });
					break;
				}
			}
			cont = br.getbit();
		} while (cont);
		return commands;
	}

	// Decode the pending Conditional buffers (GPAC gf_bifs_flush_command_list): each against the
	// DEF table as it stands now, in passes -- a buffer naming a node that is not DEF'd yet
	// (another buffer may insert it, or a later access unit) stays pending. With `final`, what
	// is still pending gets its error.
	resolveCommandBuffers(final = false) {
		if (!this.pendingBuffers.length) return;
		// A buffer is a command frame of its own: the quantization state of the frame being read is kept.
		const saved = [this.activeQP, this.qpStack.slice(), this.storingCoord, this.coordStored, this.numCoord];
		let progress = true;
		while (progress && this.pendingBuffers.length) {
			progress = false;
			const pass = this.pendingBuffers;
			this.pendingBuffers = [];
			for (const item of pass) {
				const added = this.pendingBuffers.length;
				try {
					if (item.bytes.length) this.readCommandFrame(new BifsBitReader(item.bytes), item.value.commands, true);
					progress = true;
				} catch (e) {
					item.value.commands.length = 0;
					this.pendingBuffers.length = added;      // the buffers of the commands just dropped
					item.error = String(e?.message ?? e);
					if (!(e instanceof UnknownNodeError)) {
						item.value.error = item.error;
						progress = true;
					} else {
						this.pendingBuffers.push(item);
					}
				}
			}
		}
		if (final) {
			for (const item of this.pendingBuffers) item.value.error = item.error;
			this.pendingBuffers = [];
		}
		[this.activeQP, this.qpStack, this.storingCoord, this.coordStored, this.numCoord] = saved;
	}

	// Decode one access unit, persisting the DEF table across calls (AU 0 = SceneReplacement,
	// AUs 1..N = update commands). A frame that fails partway returns the commands read before
	// the failure, with `error`.
	decodeAU(bytes) {
		const br = new BifsBitReader(bytes);
		const commands = [];
		let error = null;
		try { this.readCommandFrame(br, commands); }
		catch (e) { error = String(e?.message ?? e); }
		this.resolveCommandBuffers();
		const au = { commands, bitsConsumed: br.bitsConsumed(), byteLength: bytes.length };
		return error === null ? au : { ...au, error };
	}
}

/**
 * Decode one BIFS-Command access unit into a list of commands (the first is
 * normally a SceneReplacement whose `.scene.root` is the scene tree).
 * @param {Uint8Array} bytes  one access unit (sample)
 * @param {object} config     the BIFSConfig (nodeIDbits/routeIDbits/...)
 * @returns {{ commands: object[], bitsConsumed: number, byteLength: number, defs: Map }}
 *   `defs` maps nodeID -> { node, ... } for DEF'd nodes, so consumers can resolve
 *   `{ use: nodeID }` references in the tree to the actual (shared) node object.
 */
export function decodeCommandFrame(bytes, config) {
	const br = new BifsBitReader(bytes);
	const dec = new BifsDecoder(config);
	const commands = dec.readCommandFrame(br);
	dec.resolveCommandBuffers(true);
	return { commands, bitsConsumed: br.bitsConsumed(), byteLength: bytes.length, defs: dec.defs };
}

/**
 * Decode a whole BIFS-Command stream (all access units in order) into command records; the
 * DEF table carries across AUs. Nothing is applied: `scene` and `routes` are the last
 * SceneReplacement's, as coded. A desync in one AU is contained (each AU re-reads from its
 * own byte boundary) -- it's recorded as an error on that AU, with the commands read before
 * it, and decoding continues.
 * @param {Uint8Array[]} samples  access units in decode order
 * @param {object} config         the BIFSConfig
 * @returns {{ aus: object[], scene: object|null, routes: object[], defs: Map }}
 */
export function decodeStream(samples, config) {
	const dec = new BifsDecoder(config);
	const aus = samples.map((au, i) => ({ i, ...dec.decodeAU(au) }));
	dec.resolveCommandBuffers(true);
	return { aus, scene: dec.sceneRoot, routes: dec.routes, defs: dec.defs };
}

// The node set of the "video/audio wrapper" boilerplate scene: a top group (or a
// bare Shape) that just composites an existing media object full-frame -- a Shape
// with a Bitmap geometry textured by a MovieTexture/ImageTexture, and/or a Sound2D
// playing an AudioSource. Anything outside this set is real scene content we don't
// render yet.
const BOILERPLATE_NODES = new Set([
	"OrderedGroup", "Group", "Shape", "Appearance", "Bitmap",
	"MovieTexture", "ImageTexture", "Sound2D", "AudioSource",
]);

function collectOdRefs(url, out) {
	if (Array.isArray(url)) for (const u of url) if (u && typeof u.od === "number") out.push(u.od);
}

/**
 * Classify a decoded scene tree as the trivial media-wrapper "boilerplate" (which
 * the existing A/V playback already covers) vs a "complex" scene with nodes we
 * don't render. Also extracts the ObjectDescriptor IDs the scene's media nodes
 * reference, so the container can bind the exact video/audio ES the scene names.
 * @param {object|null} root  scene root (commands[].scene.root)
 * @returns {{ kind: "empty"|"boilerplate"|"complex", nodeTypes: string[], extraNodes: string[], videoOd: number[], audioOd: number[] }}
 */
export function classifyScene(root) {
	const types = new Set();
	const videoOd = [], audioOd = [];
	(function walk(n) {
		if (!n || typeof n !== "object" || typeof n.type !== "string") return;
		types.add(n.type);
		if (n.type === "MovieTexture" || n.type === "ImageTexture") collectOdRefs(n.fields?.url, videoOd);
		else if (n.type === "AudioSource") collectOdRefs(n.fields?.url, audioOd);
		for (const v of Object.values(n.fields || {})) {
			if (Array.isArray(v)) v.forEach(walk);
			else walk(v);
		}
	})(root);
	const nodeTypes = [...types];
	const extraNodes = nodeTypes.filter(t => !BOILERPLATE_NODES.has(t));
	const kind = nodeTypes.length === 0 ? "empty" : (extraNodes.length ? "complex" : "boilerplate");
	return { kind, nodeTypes, extraNodes, videoOd, audioOd };
}

export { BifsDecoder };
