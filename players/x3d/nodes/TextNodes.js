/*
** The BIFS Text geometry and its FontStyle. Defaults: GPAC's mpeg4_nodes.c (Text_Create, FontStyle_Create).
**
** Text is a geometry under a Shape and draws as VECTOR OUTLINES: its glyph outlines go into one gfx PathShape,
** which the Shape fills and strokes like any other geometry (Material2D fill, LineProperties outline, any
** Transform2D), and a route that writes string, a FontStyle field or the material shows on the next frame
** (Sigurd, 2026-11-11, #1852). Not the UI's glyph atlas.
**
** Layout follows GPAC's build_text (src/compositor/mpeg4_text.c) and its span drawing (font_engine.c,
** gf_font_span_draw_2d), read, not recalled:
** - size is in scene units (pixels in a pixel-metric scene, meters otherwise); a size <= 0 or no FontStyle
**   gives 12 pixels, or 12 / the scene's width in a meter scene (the host says which, bindHost);
** - ascent and descent are the face's (FreeType's ascender / descender: hhea, or the OS/2 typo values when
**   USE_TYPO_METRICS is set), scaled by size / unitsPerEm; glyphs advance by their hmtx advance, no kerning;
** - each non-empty string is one line; lines advance by size x spacing. An EMPTY string makes no line and
**   does not advance (GPAC makes no span for it), though it still counts in the total height;
** - justify[0] (major) places each line along its direction: MIDDLE centers it, END ends it at the origin,
**   anything else (BEGIN, FIRST, LEFT...) starts it there. justify[1] (minor) places the block across:
**   FIRST (the default) puts the first baseline on the origin, BEGIN the block's top, MIDDLE its center,
**   END its bottom;
** - leftToRight FALSE (horizontal) or topToBottom FALSE (vertical) reverses the glyphs of each line;
**   topToBottom FALSE (horizontal) stacks the lines upward, leftToRight FALSE (vertical) leftward;
** - length[i] > 0 scales line i to that extent; maxExtent > 0 scales every line by maxExtent / the longest
**   line when that is longer. The scales squeeze the glyphs along the line only;
** - style: BOLD and ITALIC are searched as substrings (BOLDITALIC is both); PLAIN, LIGHT and the rest are
**   the regular face.
** Vertical text (horizontal FALSE) stacks upright glyphs downward by FreeType's synthesized vertical advance
** (sfnt/ttmtx.c: sTypoAscender - sTypoDescender, or the hhea pair without OS/2); openfont reads no vhea/vmtx.
**
** Faces: the gfx font registry (g.FontUtils.js), the outlines through openfont's readGlyph, as SWFNode's
** device fonts. GPAC's generic families are Times New Roman (SERIF), Arial (SANS) and Courier New (TYPEWRITER;
** modules/ft_font/ft_font.c): each is taken when registered (the local font scan), else the bundled face:
** Tinos, Arimo and Cousine, each metric-compatible with the one it stands in for. A named family is looked up by name, then through gfx's substitution tables; a family
** nothing answers falls to SERIF, GPAC's default font. No synthetic bold or oblique: a family with no such
** face draws its nearest one (the bundled Tinos, Arimo and Cousine have no italic).
** Until a face is registered the Text draws nothing and asks the host to draw again later (bindHost).
**
** Picking follows gf_font_spans_pick: inside the line's box (its extent x ascent + descent), then inside one
** glyph's box. GPAC measures the glyph boxes without the length / maxExtent scale; here they sit where the
** glyphs are drawn.
**
** Not built (the 479 conformance scenes use none of them): maxExtent < 0 (GPAC trims the line with "..."),
** the style words UNDERLINED, STRIKETHROUGH, HIGHLIGHT, TEXTURED, OUTLINED and PASSWD, FontStyle.language
** and right-to-left scripts, and splitting a Text into words or letters for a Form or Layout parent
** (build_text_split). A texture on a Text is skipped by the Shape, as on every geometry but a Bitmap.
*/

import {PathBuilder} from "@sigurd/gfx/shapes/PathShape.js";
import {fontsByFamily, fontsByPSName, fontFamilies, fontList} from "@sigurd/gfx/g.FontUtils.js";
import {replacementForAnyName, pickBundledFace} from "@sigurd/gfx/g.FontSubstitution.js";
import {X3DNode} from "./X3DNode.js";
import {X3DGeometryNode2D} from "./GeometryNodes.js";

/** GPAC's size when FontStyle gives none, in pixels. */
export const DEFAULT_PIXEL_SIZE = 12;

/** GPAC's generic families: its first choice, then the face the apps ship. */
const GENERIC_FAMILIES = {
	SERIF: ["Times New Roman", "Tinos"],
	SANS: ["Arial", "Arimo"],
	TYPEWRITER: ["Courier New", "Cousine"],
};

function genericFamily(name)
{
	const upper = name.toUpperCase();
	if (upper === "SERIF") {
		return GENERIC_FAMILIES.SERIF;
	}
	if (upper === "SANS" || upper === "SANS-SERIF") {
		return GENERIC_FAMILIES.SANS;
	}
	if (upper === "TYPEWRITER" || upper === "MONOSPACE") {
		return GENERIC_FAMILIES.TYPEWRITER;
	}
	return null;
}

// ---- the face: metrics and outlines of one registered font --------------------------------------------

/** A line feed: GPAC gives it a glyph with no advance and no outline. */
const LINE_FEED_GLYPH = Object.freeze({advance: 0, vertAdvance: 0, ops: [], points: [], xMin: 0, xMax: 0, yMax: 0});

let nextFaceId = 1;

/** A composite glyph's components may nest; a font that nests deeper than this is broken. */
const MAX_COMPONENT_DEPTH = 8;

/**
 * Append glyph `glyphIndex` under the transform x' = a x + c y + e, y' = b x + d y + f to ops / points
 * (openfont's opcodes: 0 moveTo, 1 lineTo, 2 quadratic, 5 close), components included.
 */
function appendOutline(otf, glyphIndex, a, b, c, d, e, f, ops, points, depth)
{
	const glyph = otf.readGlyph(glyphIndex);
	if (!glyph) {
		return;
	}
	if (glyph.ops && glyph.points) {
		const source = glyph.points;
		let at = 0;
		for (const op of glyph.ops) {
			ops.push(op);
			const count = op === 2 ? 2 : (op === 0 || op === 1) ? 1 : 0;
			for (let k = 0; k < count; ++k) {
				const x = source[at++];
				const y = source[at++];
				points.push(a * x + c * y + e, b * x + d * y + f);
			}
		}
	}
	if (glyph.components && depth < MAX_COMPONENT_DEPTH) {
		for (const component of glyph.components) {
			const m = component.m;	// x' = m0 x + m2 y + m4, y' = m1 x + m3 y + m5
			appendOutline(otf, component.glyphIndex,
				a * m[0] + c * m[1], b * m[0] + d * m[1],
				a * m[2] + c * m[3], b * m[2] + d * m[3],
				a * m[4] + c * m[5] + e, b * m[4] + d * m[5] + f,
				ops, points, depth + 1);
		}
	}
}

/**
 * What the layout needs of a font (an openfont OpenFont with hhea), in font units, as GPAC's FreeType
 * reader gives them (ft_get_font_info, ft_load_glyph): unitsPerEm, ascent, descent (negative),
 * maxAdvanceH / maxAdvanceV (the advance of a character the font has no glyph for), and
 * glyph(codePoint) -> {advance, vertAdvance, ops, points, xMin, xMax, yMax} or null for a missing one.
 */
export function textFace(otf)
{
	const hhea = otf.hhea;
	const os2 = otf.os2 ?? null;
	// FreeType's ascender / descender / height (sfnt/sfobjs.c): typo metrics when USE_TYPO_METRICS is set,
	// else hhea; a zero hhea pair falls to the typo values, then the win values.
	let ascent = hhea.ascender;
	let descent = hhea.descender;
	let lineGap = hhea.lineGap;
	if (os2 && (os2.fsSelection & 128)) {
		ascent = os2.sTypoAscender;
		descent = os2.sTypoDescender;
		lineGap = os2.sTypoLineGap;
	} else if (!ascent && !descent && os2) {
		if (os2.sTypoAscender || os2.sTypoDescender) {
			ascent = os2.sTypoAscender;
			descent = os2.sTypoDescender;
			lineGap = os2.sTypoLineGap;
		} else {
			ascent = os2.usWinAscent;
			descent = -os2.usWinDescent;
			lineGap = 0;
		}
	}
	// No vertical metrics are read: FreeType's stand-in advance height (sfnt/ttmtx.c).
	const vertAdvance = os2 ? Math.abs(os2.sTypoAscender - os2.sTypoDescender) : Math.abs(hhea.ascender - hhea.descender);
	const glyphs = new Map();	// glyph index -> glyph

	return {
		id: nextFaceId++,
		unitsPerEm: otf.head.unitsPerEm,
		ascent,
		descent,
		maxAdvanceH: hhea.advanceWidthMax,
		maxAdvanceV: ascent - descent + lineGap,
		glyph(codePoint) {
			if (codePoint === 0x0A) {
				return LINE_FEED_GLYPH;
			}
			const glyphIndex = codePoint === 0x09 ? 0 : otf.codeToGlyphIndex(codePoint);
			if (!glyphIndex) {
				return null;	// a tab, or a character the font does not have
			}
			let glyph = glyphs.get(glyphIndex);
			if (!glyph) {
				const ops = [];
				const points = [];
				appendOutline(otf, glyphIndex, 1, 0, 0, 1, 0, 0, ops, points, 0);
				let xMin = Infinity;
				let xMax = -Infinity;
				let yMax = -Infinity;
				for (let i = 0; i < points.length; i += 2) {
					xMin = Math.min(xMin, points[i]);
					xMax = Math.max(xMax, points[i]);
					yMax = Math.max(yMax, points[i + 1]);
				}
				if (!points.length) {
					// GPAC's box of an empty glyph (a space): the widest advance, from the ascent down.
					xMin = 0;
					xMax = hhea.advanceWidthMax;
					yMax = ascent;
				}
				glyph = {advance: otf.readGlyph(glyphIndex).advanceWidth, vertAdvance, ops, points, xMin, xMax, yMax};
				glyphs.set(glyphIndex, glyph);
			}
			return glyph;
		},
	};
}

// ---- which registered font a FontStyle names ------------------------------------------------------------

/** The outline faces of a family, by its name as registered or in any case. */
function familyFaces(name)
{
	let faces = Object.hasOwn(fontsByFamily, name) ? fontsByFamily[name] : null;
	if (!faces) {
		const lower = name.toLowerCase();
		faces = fontFamilies.find((family) => typeof family.familyName === "string" && family.familyName.toLowerCase() === lower);
	}
	if (!Array.isArray(faces)) {
		return null;
	}
	const outlines = faces.filter((font) => font.otf && font.otf.hhea);
	return outlines.length ? outlines : null;
}

/** The face of a family nearest the style: italic or upright first, then normal width, then the weight. */
function nearestStyle(faces, bold, italic)
{
	let best = null;
	let bestCost = Infinity;
	for (const font of faces) {
		const os2 = font.otf.os2;
		const subFamily = String(font.subFamilyName ?? "");
		const faceItalic = os2 ? (os2.fsSelection & 1) !== 0 : /italic|oblique/i.test(subFamily);
		const weight = os2 ? os2.usWeightClass : (/bold/i.test(subFamily) ? 700 : 400);
		const width = os2 ? os2.usWidthClass : 5;
		const cost = (faceItalic === italic ? 0 : 100000) + Math.abs(width - 5) * 10000 + Math.abs(weight - (bold ? 700 : 400));
		if (cost < bestCost) {
			best = font;
			bestCost = cost;
		}
	}
	return best;
}

/** The faces a family name stands for: the family itself, else what gfx substitutes for the name. */
function namedFamilyFaces(name)
{
	const faces = familyFaces(name);
	if (faces) {
		return faces;
	}
	// The replacement table can name a face this machine lacks ("Arial" -> "ArialMT" with no local Arial): the
	// bundled stand-in is tried then, not only when the table has no answer.
	for (const psName of [replacementForAnyName([name]), pickBundledFace(name)]) {
		const font = psName ? fontsByPSName[psName] : null;
		if (font && typeof font.familyName === "string") {
			const faces = familyFaces(font.familyName);
			if (faces) {
				return faces;
			}
		}
	}
	return null;
}

function resolveFont(families, bold, italic)
{
	for (const name of [...families, "SERIF"]) {	// GPAC's default font is SERIF
		// GPAC reads a missing name as SANS.
		const generic = genericFamily(typeof name === "string" && name.length ? name : "SANS");
		if (generic) {
			for (const candidate of generic) {
				const faces = familyFaces(candidate);
				if (faces) {
					return nearestStyle(faces, bold, italic);
				}
			}
		} else {
			const faces = namedFamilyFaces(name);
			if (faces) {
				return nearestStyle(faces, bold, italic);
			}
		}
	}
	return null;
}

/** Resolutions against the registry as it stands: emptied when a font joins it. */
const resolved = new Map();		// "bold italic families" -> registry font or null
let resolvedFontCount = -1;
const faces = new WeakMap();	// OpenFont -> textFace

/** The face for a family list and style, or null while the registry has none. */
function findFace(families, bold, italic)
{
	if (resolvedFontCount !== fontList.length) {
		resolved.clear();
		resolvedFontCount = fontList.length;
	}
	const key = (bold ? "B" : "-") + (italic ? "I" : "-") + families.join("\n");
	let font = resolved.get(key);
	if (font === undefined) {
		font = resolveFont(families, bold, italic);
		resolved.set(key, font);
	}
	if (!font) {
		return null;
	}
	let face = faces.get(font.otf);
	if (!face) {
		face = textFace(font.otf);
		faces.set(font.otf, face);
	}
	return face;
}

// ---- layout: GPAC's build_text ---------------------------------------------------------------------------

/** GPAC's rectangle: (x, y) is the top-left corner, Y up, so it spans y - height .. y. */
function unionRect(into, rect)
{
	if (!into.width || !into.height) {
		into.x = rect.x;
		into.y = rect.y;
		into.width = rect.width;
		into.height = rect.height;
		return;
	}
	if (!rect.width || !rect.height) {
		return;
	}
	const left = Math.min(into.x, rect.x);
	const right = Math.max(into.x + into.width, rect.x + rect.width);
	const top = Math.max(into.y, rect.y);
	const bottom = Math.min(into.y - into.height, rect.y - rect.height);
	into.x = left;
	into.y = top;
	into.width = right - left;
	into.height = top - bottom;
}

/**
 * Lay a Text out with a face (textFace). `text` gives string, length and maxExtent, `fontStyle` the
 * FontStyle fields or null, `defaultSize` the size when FontStyle gives none.
 *
 * Returns {ascent, descent, bounds, spans}: one span per non-empty string, {glyphs, horizontal, scaleX,
 * scaleY, x, y, bounds}. A span's glyphs are drawn from the pen (x, y) on: a glyph's font-unit point
 * (gx, gy) lands on (pen.x + scaleX gx, pen.y + scaleY gy), then the pen moves scaleX x advance to the
 * right (horizontal) or scaleY x vertAdvance down; a null glyph moves it by the face's largest advance.
 * Bounds are GPAC's rectangles: (x, y) the top-left corner, Y up.
 */
export function layoutText(text, fontStyle, face, defaultSize)
{
	const fs = fontStyle;
	let size = fs ? fs.size : -1;
	if (!(size > 0)) {
		size = defaultSize;
	}
	const horizontal = fs ? !!fs.horizontal : true;
	const leftToRight = fs ? !!fs.leftToRight : true;
	const topToBottom = fs ? !!fs.topToBottom : true;
	const justify = fs && Array.isArray(fs.justify) ? fs.justify : [];
	const major = justify[0] || "FIRST";
	const minor = justify[1] || "FIRST";

	const fontScale = size / face.unitsPerEm;
	const ascent = size * face.ascent / face.unitsPerEm;
	const descent = -size * face.descent / face.unitsPerEm;
	const lineSpacing = (fs ? fs.spacing : 1) * size;

	const strings = Array.isArray(text.string) ? text.string : [];
	const lengths = Array.isArray(text.length) ? text.length : [];
	const spans = [];
	let totalWidth = 0;
	let totalHeight = 0;
	for (let i = 0; i < strings.length; ++i) {
		const string = strings[i];
		if (typeof string !== "string" || !string.length) {
			continue;
		}
		const glyphs = [];
		for (const character of string) {
			glyphs.push(face.glyph(character.codePointAt(0)));
		}
		if ((horizontal && !leftToRight) || (!horizontal && !topToBottom)) {
			glyphs.reverse();
		}
		let extent = 0;
		for (const glyph of glyphs) {
			if (horizontal) {
				extent += glyph ? glyph.advance : face.maxAdvanceH;
			} else {
				extent += glyph ? glyph.vertAdvance : face.maxAdvanceV;
			}
		}
		extent *= fontScale;
		const span = {glyphs, horizontal, scaleX: fontScale, scaleY: fontScale, x: 0, y: 0, bounds: {x: 0, y: 0, width: 0, height: 0}};
		// length[i] stretches or squeezes the line to that extent.
		let lengthScale = 1;
		if (lengths[i] > 0 && extent > 0) {
			lengthScale = lengths[i] / extent;
			extent = lengths[i];
		}
		if (horizontal) {
			span.scaleX *= lengthScale;
			span.bounds.width = extent;
			totalWidth = Math.max(totalWidth, extent);
		} else {
			span.scaleY *= lengthScale;
			span.bounds.height = extent;
			totalHeight = Math.max(totalHeight, extent);
		}
		spans.push(span);
	}

	// The minor axis: where the first line starts across the block.
	const maxExtent = text.maxExtent;
	let maxScale = 1;
	let startX = 0;
	let startY = 0;
	if (horizontal) {
		if (maxExtent > 0 && totalWidth > maxExtent) {
			maxScale = maxExtent / totalWidth;
		}
		totalHeight = (strings.length - 1) * lineSpacing + ascent + descent;
		if (minor === "MIDDLE") {
			startY = topToBottom ? totalHeight / 2 : descent + ascent - totalHeight / 2;
		} else if (minor === "BEGIN") {
			startY = topToBottom ? 0 : descent + ascent;
		} else if (minor === "END") {
			startY = topToBottom ? totalHeight : -totalHeight + 2 * descent + ascent;
		} else {
			startY = ascent;
		}
	} else {
		if (maxExtent > 0 && totalHeight > maxExtent) {
			maxScale = maxExtent / totalHeight;
		}
		totalWidth = strings.length * lineSpacing;
		if (minor === "MIDDLE") {
			startX = leftToRight ? -totalWidth / 2 : totalWidth / 2 - lineSpacing;
		} else if (minor === "END") {
			startX = leftToRight ? -totalWidth : totalWidth - lineSpacing;
		} else {
			startX = leftToRight ? 0 : -lineSpacing;
		}
	}

	// The major axis, line by line. start is the line's top-left corner; its pen starts an ascent below.
	const bounds = {x: 0, y: 0, width: 0, height: 0};
	for (const span of spans) {
		if (major === "MIDDLE") {
			if (horizontal) {
				startX = -span.bounds.width / 2;
			} else {
				startY = span.bounds.height / 2;
			}
		} else if (major === "END") {
			if (horizontal) {
				startX = leftToRight ? -span.bounds.width : 0;
			} else {
				startY = topToBottom ? span.bounds.height : 0;
			}
		} else if (horizontal) {
			startX = leftToRight ? 0 : -span.bounds.width;
		} else {
			startY = topToBottom ? 0 : span.bounds.height;
		}
		span.bounds.x = startX;
		span.bounds.y = startY;
		if (horizontal) {
			span.scaleX *= maxScale;
			span.x = startX * maxScale;
			span.y = (startY - ascent) * maxScale;
			startY += topToBottom ? -lineSpacing : lineSpacing;
			span.bounds.height = descent + ascent;
		} else {
			span.scaleY *= maxScale;
			span.x = startX * maxScale;
			// The ascent takes the line's own scale (length and maxExtent), then maxExtent's again: GPAC.
			span.y = (startY - ascent * span.scaleY / fontScale) * maxScale;
			startX += leftToRight ? lineSpacing : -lineSpacing;
			span.bounds.width = lineSpacing;
		}
		unionRect(bounds, span.bounds);
	}
	return {ascent, descent, bounds, spans};
}

/** Walk a span's glyphs: visit(glyph, penX, penY) for each one the face has. */
function eachGlyph(span, face, visit)
{
	let x = span.x;
	let y = span.y;
	for (const glyph of span.glyphs) {
		if (glyph) {
			visit(glyph, x, y);
		}
		if (span.horizontal) {
			x += span.scaleX * (glyph ? glyph.advance : face.maxAdvanceH);
		} else {
			y -= span.scaleY * (glyph ? glyph.vertAdvance : face.maxAdvanceV);
		}
	}
}

// ---- the nodes --------------------------------------------------------------------------------------------

/** A string into a key of numbers: its length, then its UTF-16 units. */
function pushString(key, string)
{
	const text = typeof string === "string" ? string : "";
	key.push(text.length);
	for (let i = 0; i < text.length; ++i) {
		key.push(text.charCodeAt(i));
	}
}

function pushStrings(key, strings)
{
	const list = Array.isArray(strings) ? strings : [];
	key.push(list.length);
	for (const string of list) {
		pushString(key, string);
	}
}

export class FontStyle extends X3DNode
{
	constructor()
	{
		super("FontStyle");
		this.family = ["SERIF"];
		this.horizontal = true;
		this.justify = ["BEGIN"];
		this.language = "";
		this.leftToRight = true;
		this.size = 1;
		this.spacing = 1;
		this.style = "PLAIN";
		this.topToBottom = true;
	}
}

export class Text extends X3DGeometryNode2D
{
	constructor()
	{
		super("Text");
		this.string = [];
		this.length = [];
		this.fontStyle = null;		// FontStyle
		this.maxExtent = 0;
		this._host = null;			// the host's draw context of the last draw (bindHost), null before the first
		this._face = null;			// the face of the last pathKey
		this._layout = null;		// the layout of the last buildParts, for picking and bounds
	}

	/**
	 * What the Text needs from the host of its scene is asked of the draw context, each draw: `defaultTextSize`,
	 * the default size in scene units (12 pixels), and `fontsPending()` for "no face yet, draw me again later". So
	 * a Text that joins the scene later is served as one that was there from the start. Before its first draw the
	 * size is 12 units and nothing is asked.
	 */
	bindHost(host)
	{
		this._host = host;
	}

	defaultSize()
	{
		return this._host ? this._host.defaultTextSize : DEFAULT_PIXEL_SIZE;
	}

	style()
	{
		return this.fontStyle instanceof FontStyle ? this.fontStyle : null;
	}

	/** The face the FontStyle names, or null while none is registered (the host is then asked to come back). */
	face()
	{
		const fs = this.style();
		const style = fs && typeof fs.style === "string" ? fs.style : "";
		const bold = style.includes("BOLD") || style.includes("bold");
		const italic = style.includes("ITALIC") || style.includes("italic");
		const face = findFace(fs && Array.isArray(fs.family) ? fs.family : [], bold, italic);
		if (!face && this._host) {
			this._host.fontsPending();
		}
		return face;
	}

	pathKey()
	{
		const fs = this.style();
		const face = this._face = this.face();
		const key = [face ? face.id : 0, this.defaultSize(), this.maxExtent];
		pushStrings(key, this.string);
		const lengths = Array.isArray(this.length) ? this.length : [];
		key.push(lengths.length, ...lengths);
		if (fs) {
			key.push(fs.horizontal ? 1 : 0, fs.leftToRight ? 1 : 0, fs.topToBottom ? 1 : 0, fs.size, fs.spacing);
			pushStrings(key, fs.justify);
		}
		return key;
	}

	buildParts()
	{
		const face = this._face ?? this.face();
		if (!face) {
			this._layout = null;
			return [];
		}
		const layout = this._layout = layoutText(this, this.style(), face, this.defaultSize());
		const builder = new PathBuilder();
		let drawn = false;
		for (const span of layout.spans) {
			const sx = span.scaleX;
			const sy = span.scaleY;
			eachGlyph(span, face, (glyph, x, y) => {
				const points = glyph.points;
				let at = 0;
				for (const op of glyph.ops) {
					if (op === 0) {
						builder.moveTo(x + sx * points[at], y + sy * points[at + 1]);
						at += 2;
						drawn = true;
					} else if (op === 1) {
						builder.lineTo(x + sx * points[at], y + sy * points[at + 1]);
						at += 2;
					} else if (op === 2) {
						builder.quadraticTo(x + sx * points[at], y + sy * points[at + 1], x + sx * points[at + 2], y + sy * points[at + 3]);
						at += 4;
					} else if (op === 5) {
						builder.close();
					}
				}
			});
		}
		return drawn ? [{path: builder.path, color: null}] : [];
	}

	/** GPAC's bounds of the text, {x, y, width, height} with (x, y) the top-left corner (Y up), or null before a face. */
	bounds()
	{
		return this._layout ? this._layout.bounds : null;
	}

	/** GPAC's pick: inside a line's box, then inside the box of one of its glyphs (not the outline itself). */
	containsPoint(x, y, parts)
	{
		const layout = this._layout;
		const face = this._face;
		if (!layout || !face) {
			return false;
		}
		// GPAC's glyph box is ascent + descent high with the face's NEGATIVE descent: from the glyph's top down.
		const boxHeight = face.ascent + face.descent;
		for (const span of layout.spans) {
			const box = span.bounds;
			if (x < box.x || x > box.x + box.width || y > box.y || y < box.y - box.height) {
				continue;
			}
			let hit = false;
			eachGlyph(span, face, (glyph, penX, penY) => {
				const gx = (x - penX) / span.scaleX;
				const gy = (y - penY) / span.scaleY;
				if (gx >= glyph.xMin && gx <= glyph.xMax && gy <= glyph.yMax && gy >= glyph.yMax - boxHeight) {
					hit = true;
				}
			});
			if (hit) {
				return true;
			}
		}
		return false;
	}
}
