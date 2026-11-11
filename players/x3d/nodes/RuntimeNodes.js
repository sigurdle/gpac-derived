/*
** The small BIFS runtime nodes: Valuator, CoordinateInterpolator2D, the drag sensors PlaneSensor2D and
** DiscSensor, ProximitySensor2D, and Anchor. All but Anchor draw nothing.
**
** Read from GPAC: Valuator from src/scenegraph/mpeg4_valuator.c, the sensors and Anchor from
** src/compositor/mpeg4_sensors.c (mouse paths only; the keyboard paths are not built),
** CoordinateInterpolator2D from src/scenegraph/vrml_interpolators.c. Defaults: mpeg4_nodes.c (*_Create).
**
** Anchor draws and picks its children as a Group. A click on them only LOGS the url for now: nothing is
** opened, and a "#name" url binds nothing.
*/

import {X3DNode} from "./X3DNode.js";
import {X3DGroupingNode} from "./GroupingNodes.js";
import {X3DInterpolatorNode} from "./SensorNodes.js";

// ---- Valuator ----------------------------------------------------------------

/** Each eventIn: how many components its value (or each MF element) has, and whether it is an MF. */
const VALUATOR_INS = new Map([
	["inSFBool", {count: 1, mf: false}],
	["inSFFloat", {count: 1, mf: false}],
	["inSFInt32", {count: 1, mf: false}],
	["inSFTime", {count: 1, mf: false}],
	["inSFString", {count: 1, mf: false}],
	["inSFColor", {count: 3, mf: false}],
	["inSFVec2f", {count: 2, mf: false}],
	["inSFVec3f", {count: 3, mf: false}],
	["inSFRotation", {count: 4, mf: false}],
	["inMFFloat", {count: 1, mf: true}],
	["inMFInt32", {count: 1, mf: true}],
	["inMFString", {count: 1, mf: true}],
	["inMFColor", {count: 3, mf: true}],
	["inMFVec2f", {count: 2, mf: true}],
	["inMFVec3f", {count: 3, mf: true}],
	["inMFRotation", {count: 4, mf: true}],
]);

/** C's atoi: leading blanks, a sign, digits; anything else is 0. */
function atoi(s)
{
	const m = /^\s*[+-]?\d+/.exec(s);
	return m ? parseInt(m[0], 10) : 0;
}

/**
 * A string as a number (ISO/IEC 14496-11 9.4.2.116.2, as GPAC reads it): "true" in any case is 1, a
 * string with no "." goes through atoi, one with a "." through atof; anything else is 0.
 */
function stringNumber(s)
{
	if (typeof s !== "string") {
		return 0;
	}
	if (s.toLowerCase() === "true") {
		return 1;
	}
	if (!s.includes(".")) {
		return atoi(s);
	}
	const v = parseFloat(s);
	return Number.isNaN(v) ? 0 : v;
}

/**
 * One input value as four components: a scalar (bool, number, string) fills all four ("for all components
 * i of output.i, input.i shall take the value of the scalar input"), a vector fills its own and leaves the
 * rest 0.
 */
function fourComponents(value, count)
{
	if (count === 1) {
		let v;
		if (typeof value === "string" || value === null || value === undefined) {
			v = stringNumber(value);
		} else {
			v = value === true ? 1 : Number(value);
		}
		return [v, v, v, v];
	}
	return [value[0], value[1], count > 2 ? value[2] : 0, count > 3 ? value[3] : 0];
}

function stripZeros(s)
{
	return s.includes(".") ? s.replace(/0+$/, "").replace(/\.$/, "") : s;
}

/** C's "%g": six significant digits, trailing zeros dropped, an exponent below 1e-4 and from 1e6. */
function formatG(v)
{
	if (v === 0) {
		return "0";
	}
	if (!Number.isFinite(v)) {
		return Number.isNaN(v) ? "nan" : (v > 0 ? "inf" : "-inf");
	}
	const [mantissa, exponent] = v.toExponential(5).split("e");
	const exp = Number(exponent);
	if (exp < -4 || exp >= 6) {
		return stripZeros(mantissa) + "e" + exponent[0] + exponent.slice(1).padStart(2, "0");
	}
	return stripZeros(v.toFixed(5 - exp));
}

function twoDigits(n)
{
	return String(n).padStart(2, "0");
}

/** GPAC's format_sftime_string: seconds as hh:mm:ss. */
function formatTime(seconds)
{
	const neg = seconds < 0;
	const val = Math.abs(seconds);
	const h = Math.floor(val / 3600);
	const m = Math.floor(val / 60) - h * 60;
	const s = Math.floor(val) - h * 3600 - m * 60;
	return (neg ? "-" : "") + twoDigits(h) + ":" + twoDigits(m) + ":" + twoDigits(s);
}

/**
 * Valuator: any in* event becomes every out* type. Each of the four components is Factor * in + Offset;
 * with Sum, all four take the sum of the four. As GPAC's SetValuatorOutput: an MF input converts element
 * by element, the SF outputs take its first element; ints truncate toward zero; outSFBool is "x is not 0";
 * the strings are C-formatted (outSFString "%.6f", "%.4f %.4f", "%.3f" x3, "%.2f" x4 by the input's
 * component count, outMFString "%g"; an inSFTime prints as hh:mm:ss). Every out* is sent; only the routed
 * ones go anywhere.
 */
export class Valuator extends X3DNode
{
	constructor()
	{
		super("Valuator");
		this.Factor1 = 1;
		this.Factor2 = 1;
		this.Factor3 = 1;
		this.Factor4 = 1;
		this.Offset1 = 0;
		this.Offset2 = 0;
		this.Offset3 = 0;
		this.Offset4 = 0;
		this.Sum = false;
	}

	receive(name, value, scene, time)
	{
		const input = VALUATOR_INS.get(name);
		if (!input) {
			super.receive(name, value, scene, time);
			return;
		}
		if (name === "inSFString" && typeof value !== "string") {
			return;
		}
		const elements = input.mf ? (Array.isArray(value) ? value : []) : [value];
		const out = elements.map((element) => this._convert(fourComponents(element, input.count)));
		const first = out.length ? out[0] : [0, 0, 0, 0];
		const isTime = name === "inSFTime";
		const n = input.count;

		scene.emit(this, "outSFBool", first[0] !== 0, time);
		scene.emit(this, "outSFColor", first.slice(0, 3), time);
		scene.emit(this, "outMFColor", out.map((v) => v.slice(0, 3)), time);
		scene.emit(this, "outSFFloat", first[0], time);
		scene.emit(this, "outMFFloat", out.map((v) => v[0]), time);
		scene.emit(this, "outSFInt32", Math.trunc(first[0]), time);
		scene.emit(this, "outMFInt32", out.map((v) => Math.trunc(v[0])), time);
		scene.emit(this, "outSFRotation", first.slice(), time);
		scene.emit(this, "outMFRotation", out.map((v) => v.slice()), time);
		let text;
		if (n === 1) {
			text = isTime ? formatTime(first[0]) : first[0].toFixed(6);
		} else {
			text = first.slice(0, n).map((c) => c.toFixed(6 - n)).join(" ");
		}
		scene.emit(this, "outSFString", text, time);
		scene.emit(this, "outMFString", out.map((v) => (isTime ? formatTime(v[0]) : v.slice(0, n).map(formatG).join(" "))), time);
		scene.emit(this, "outSFTime", first[0], time);
		scene.emit(this, "outSFVec2f", first.slice(0, 2), time);
		scene.emit(this, "outMFVec2f", out.map((v) => v.slice(0, 2)), time);
		scene.emit(this, "outSFVec3f", first.slice(0, 3), time);
		scene.emit(this, "outMFVec3f", out.map((v) => v.slice(0, 3)), time);
	}

	_convert(v)
	{
		const out = [
			this.Factor1 * v[0] + this.Offset1,
			this.Factor2 * v[1] + this.Offset2,
			this.Factor3 * v[2] + this.Offset3,
			this.Factor4 * v[3] + this.Offset4,
		];
		if (this.Sum) {
			out[0] = out[0] + out[1] + out[2] + out[3];
			out[1] = out[2] = out[3] = out[0];
		}
		return out;
	}
}

// ---- CoordinateInterpolator2D --------------------------------------------------

/**
 * keyValue holds key.length sets of points, one after the other; value_changed is one set (MFVec2f).
 * Nothing is sent when keyValue is not a whole number of sets (GPAC's CI2D_SetFraction). The ends follow
 * the other interpolators here (VRML97 4.6.8): the last set at and above the last key.
 */
export class CoordinateInterpolator2D extends X3DInterpolatorNode
{
	constructor()
	{
		super("CoordinateInterpolator2D");
	}

	interpolate(f)
	{
		const key = this.key, keyValue = this.keyValue;
		const n = key.length;
		if (n === 0 || keyValue.length % n !== 0) {
			return undefined;
		}
		const perKey = keyValue.length / n;
		if (f <= key[0]) {
			return keyValue.slice(0, perKey);
		}
		if (f >= key[n - 1]) {
			return keyValue.slice(keyValue.length - perKey);
		}
		let i = 0;
		while (i < n - 2 && key[i + 1] <= f) {
			i++;
		}
		const span = key[i + 1] - key[i];
		const t = span > 0 ? (f - key[i]) / span : 1;
		const out = new Array(perKey);
		for (let k = 0; k < perKey; k++) {
			const a = keyValue[i * perKey + k], b = keyValue[(i + 1) * perKey + k];
			out[k] = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
		}
		return out;
	}
}

// ---- the drag sensors ----------------------------------------------------------

/**
 * A scene point -> the point in `sensor`'s coordinate system (its parent group's), through the transforms
 * above it as they are when called. Of a sensor used in several places, the first place in drawing order.
 * The function gives null where a transform on the way is collapsed.
 */
export function pointMapperTo(root, sensor)
{
	const path = [];
	const seen = new Set();
	const find = (node) => {
		if (node === sensor) {
			return true;
		}
		if (!node || seen.has(node)) {
			return false;
		}
		seen.add(node);
		for (const child of node.drawnChildren()) {
			if (find(child)) {
				if (node.parentToLocal) {
					path.unshift(node);
				}
				return true;
			}
		}
		return false;
	};
	find(root);
	return (x, y) => {
		let p = [x, y];
		for (const node of path) {
			p = node.parentToLocal(p[0], p[1]);
			if (!p) {
				return null;
			}
		}
		return p;
	};
}

/**
 * A pointing sensor that follows a drag: a press over the geometry activates it and it keeps the pointer
 * until the release, wherever the pointer goes; points are in the sensor's coordinate system as it was
 * found at the press. On the release autoOffset stores the last value in `offset` (and sends it) before
 * isActive FALSE. A sensor disabled while active deactivates at the next pointer event.
 */
class X3DDragSensorNode extends X3DNode
{
	static pointing = true;

	constructor(typeName)
	{
		super(typeName);
		this.autoOffset = true;
		this.enabled = true;
		this._isActive = false;		// isActive, as last sent
		this._toLocal = null;		// scene point -> sensor point, for the drag in hand
	}

	pointerOver(scene, over, t, point)
	{
	}

	press(scene, t, point)
	{
		if (!this.enabled || this._isActive || !point) {
			return false;
		}
		this._toLocal = pointMapperTo(scene.root, this);
		this._isActive = true;
		this.startDrag(point);
		scene.emit(this, "isActive", true, t);
		this.pressed(scene, point, t);
		return true;
	}

	/** The pointer moved to scene point (x, y) while this sensor has it. */
	drag(scene, x, y, t)
	{
		if (!this._isActive) {
			return;
		}
		if (!this.enabled) {
			this.release(scene, false, t);
			return;
		}
		const point = this._toLocal(x, y);
		if (point) {
			this.track(scene, point, t);
		}
	}

	release(scene, over, t)
	{
		if (!this._isActive) {
			return;
		}
		if (this.autoOffset) {
			this.offset = this.lastValue();
			scene.version++;
			scene.emit(this, "offset", this.offset, t);
		}
		this._isActive = false;
		this._toLocal = null;
		scene.emit(this, "isActive", false, t);
	}

	/** Remember where the drag starts (sensor point). */
	startDrag(point)
	{
	}

	/** What the press itself sends after isActive TRUE. */
	pressed(scene, point, t)
	{
	}

	/** Send the events for the pointer at `point`. */
	track(scene, point, t)
	{
	}

	/** The value `offset` takes at the release. */
	lastValue()
	{
		return this.offset;
	}
}

/**
 * PlaneSensor2D (GPAC's OnPlaneSensor2D): trackPoint_changed is the pointer, translation_changed the
 * pointer minus where the press was, plus offset, clamped per axis where minPosition <= maxPosition.
 * The press sends both at once. With GPAC's defaults (min = max = 0 0) the translation is held at 0 0:
 * a scene that wants a free drag sets maxPosition below minPosition.
 */
export class PlaneSensor2D extends X3DDragSensorNode
{
	constructor()
	{
		super("PlaneSensor2D");
		this.maxPosition = [0, 0];
		this.minPosition = [0, 0];
		this.offset = [0, 0];
		this._start = [0, 0];			// the press point minus offset
		this._translation = [0, 0];		// translation_changed, as last sent
	}

	startDrag(point)
	{
		this._start = [point[0] - this.offset[0], point[1] - this.offset[1]];
	}

	pressed(scene, point, t)
	{
		this.track(scene, point, t);
	}

	track(scene, point, t)
	{
		scene.emit(this, "trackPoint_changed", [point[0], point[1]], t);
		const min = this.minPosition, max = this.maxPosition;
		let x = point[0] - this._start[0], y = point[1] - this._start[1];
		if (min[0] <= max[0]) {
			x = Math.min(Math.max(x, min[0]), max[0]);
		}
		if (min[1] <= max[1]) {
			y = Math.min(Math.max(y, min[1]), max[1]);
		}
		this._translation = [x, y];
		scene.emit(this, "translation_changed", [x, y], t);
	}

	lastValue()
	{
		return this._translation;
	}
}

/**
 * DiscSensor (GPAC's OnDiscSensor): rotation_changed is the pointer's angle about the sensor's origin
 * minus the angle at the press, plus offset, clamped where minAngle < maxAngle (GPAC notes its own clamp
 * "doesn't work properly": the angle is not unwrapped, so a drag across the negative X axis jumps). The
 * press sends only isActive. rotation_changed keeps its last value between drags, as GPAC's field does.
 */
export class DiscSensor extends X3DDragSensorNode
{
	constructor()
	{
		super("DiscSensor");
		this.maxAngle = -1;
		this.minAngle = 0;
		this.offset = 0;
		this._startAngle = 0;		// the angle of the press point
		this._rotation = 0;			// rotation_changed, as last sent
	}

	startDrag(point)
	{
		this._startAngle = Math.atan2(point[1], point[0]);
	}

	track(scene, point, t)
	{
		let rotation = Math.atan2(point[1], point[0]) - this._startAngle + this.offset;
		if (this.minAngle < this.maxAngle) {
			rotation = Math.min(Math.max(rotation, this.minAngle), this.maxAngle);
		}
		this._rotation = rotation;
		scene.emit(this, "rotation_changed", rotation, t);
		scene.emit(this, "trackPoint_changed", [point[0], point[1]], t);
	}

	lastValue()
	{
		return this._rotation;
	}
}

// ---- ProximitySensor2D ---------------------------------------------------------

/**
 * As GPAC runs it (OnProximitySensor2D): a pointing sensor, not a viewer-position one. While the pointer
 * is over the sibling geometry and inside the box center +- size / 2 (sensor coordinates) it sends
 * position_changed, and isActive TRUE with enterTime on entering; on leaving the box or the geometry,
 * exitTime (the time it was last over) and isActive FALSE. orientation_changed is never sent.
 */
export class ProximitySensor2D extends X3DNode
{
	static pointing = true;

	constructor()
	{
		super("ProximitySensor2D");
		this.center = [0, 0];
		this.size = [0, 0];
		this.enabled = true;
		this._isActive = false;		// isActive, as last sent
		this._lastTime = 0;			// when the pointer was last over the geometry
	}

	pointerOver(scene, over, t, point)
	{
		if (over && point) {
			this._lastTime = t;
			const c = this.center, s = this.size;
			if (point[0] >= c[0] - s[0] / 2 && point[0] <= c[0] + s[0] / 2 &&
				point[1] >= c[1] - s[1] / 2 && point[1] <= c[1] + s[1] / 2) {
				scene.emit(this, "position_changed", [point[0], point[1]], t);
				if (!this._isActive) {
					this._isActive = true;
					scene.emit(this, "isActive", true, t);
					scene.emit(this, "enterTime", t, t);
				}
				return;
			}
		}
		if (this._isActive) {
			this._isActive = false;
			scene.emit(this, "exitTime", this._lastTime, t);
			scene.emit(this, "isActive", false, t);
		}
	}

	press(scene, t, point)
	{
		return false;
	}

	release(scene, over, t)
	{
	}

	drag(scene, x, y, t)
	{
	}
}

// ---- Anchor --------------------------------------------------------------------

function urlText(url)
{
	if (typeof url === "string") {
		return url;
	}
	if (url && typeof url.url === "string") {
		return url.url;
	}
	return url && url.od !== undefined ? "od:" + url.od : "";
}

/**
 * Anchor: a Group whose children are a link. It is its own pointing sensor over them, together with
 * any sensors among them (GPAC adds the anchor's handler to the group's), while url[0] is not empty.
 * A press and a release over the children activate it: for now that only logs the url.
 *
 * `static pointing` is true so the scene knows it takes the pointer; it has no `enabled` field, so a
 * parent group never counts it among its own child sensors.
 */
export class Anchor extends X3DGroupingNode
{
	static pointing = true;

	constructor()
	{
		super("Anchor");
		this.description = "";
		this.parameter = [];
		this.url = [];
		this._isActive = false;		// pressed, not yet released
	}

	pick(x, y, sensors, sensorPoint)
	{
		if (!this.url.length || urlText(this.url[0]) === "") {
			return super.pick(x, y, sensors, sensorPoint);
		}
		const children = this.drawnChildren();
		const own = [this, ...children.filter((child) => child && child.constructor.pointing && child.enabled)];
		for (let i = children.length - 1; i >= 0; i--) {
			const hit = children[i] ? children[i].pick(x, y, own, [x, y]) : null;
			if (hit) {
				return hit;
			}
		}
		return null;
	}

	pointerOver(scene, over, t, point)
	{
	}

	press(scene, t, point)
	{
		this._isActive = true;
		return true;
	}

	drag(scene, x, y, t)
	{
	}

	release(scene, over, t)
	{
		if (!this._isActive) {
			return;
		}
		this._isActive = false;
		if (over) {
			console.log("BIFS: Anchor activated, url " + this.url.map(urlText).join(", ") +
				(this.parameter.length ? " (" + this.parameter.join(", ") + ")" : "") + "; opening it is not built");
		}
	}
}
