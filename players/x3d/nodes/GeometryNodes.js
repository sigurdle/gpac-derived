/*
** The BIFS 2D geometry nodes: Rectangle, Circle, Curve2D, IndexedFaceSet2D, IndexedLineSet2D, PointSet2D, and the property nodes they read,
** Coordinate2D and Color. A geometry builds its own paths (gfx PathShape, as SWFNode's shapes); the Shape
** that holds it caches them, keyed on pathKey(). Defaults: GPAC's mpeg4_nodes.c (*_Create).
*/

import {PathShape, PathBuilder} from "@sigurd/gfx/shapes/PathShape.js";
import {curve2dToSegments, segmentsToPath} from "@sigurd/fileformats/helpers/bifs/BifsGeometry.js";
import {X3DNode} from "./X3DNode.js";

/** Flatten numbers and nested arrays of numbers into `out`: the geometry's identity, compared each frame. */
function flattenInto(out, value)
{
	if (typeof value === "number") {
		out.push(value);
	} else if (Array.isArray(value)) {
		for (const v of value) {
			flattenInto(out, v);
		}
	}
	return out;
}

/** flattenInto with the count of the numbers first: sections of a key stay apart without a separator. */
function flattenCounted(out, value)
{
	const at = out.length;
	out.push(0);
	flattenInto(out, value);
	out[at] = out.length - at - 1;
	return out;
}

export class Coordinate2D extends X3DNode
{
	constructor()
	{
		super("Coordinate2D");
		this.point = [];
	}
}

export class Color extends X3DNode
{
	constructor()
	{
		super("Color");
		this.color = [];
	}
}

/** A geometry the Shape draws as paths. */
export class X3DGeometryNode2D extends X3DNode
{
	/** Every number the paths depend on: the Shape rebuilds them when it changes (compared with ===: no NaN). */
	pathKey()
	{
		return [];
	}

	/**
	 * What the Shape paints of the paths: "area" (the fill and the outline the material gives), "lines" (never
	 * filled: IndexedLineSet2D) or "points" (always filled, never outlined: PointSet2D). Material2D.look reads it.
	 */
	static paint = "area";

	/**
	 * Called by the Shape before each draw with the host's draw context and the graphics context under the transforms
	 * the geometry is drawn with: a geometry that needs one keeps what it needs (Text, PointSet2D).
	 */
	bindHost(host, ctx)
	{
	}

	/** The geometry as paths: [{path: PathShape, color: [r, g, b] | null}]. */
	buildParts()
	{
		return [];
	}

	/**
	 * True if point (x, y) of the geometry's space is inside it. `parts` is what the Shape built from
	 * buildParts (cached). GPAC picks the path's area whatever the material (vrml_drawable_pick: "MPEG-4
	 * picking is always on regardless of color properties"), and then its outline where the shape has a pen
	 * width: `lineWidth` is the width of the outline as drawn, 0 for none.
	 */
	containsPoint(x, y, parts, lineWidth)
	{
		const reach = lineWidth / 2;
		for (const part of parts) {
			// The bounds first: PathShape's own tests draw on a canvas.
			const box = part.path.getBBox();
			if (box.isPointInside(x, y) && part.path.isPointInside(x, y)) {
				return true;
			}
			// A miter (limit 4) reaches at most 4 half widths beyond the path.
			if (lineWidth > 0 && x >= box.left - 4 * reach && x <= box.right + 4 * reach &&
				y >= box.top - 4 * reach && y <= box.bottom + 4 * reach &&
				part.path.isPointInsideStroke(x, y, {width: lineWidth, join: "miter"})) {
				return true;
			}
		}
		return false;
	}
}

export class Rectangle extends X3DGeometryNode2D
{
	constructor()
	{
		super("Rectangle");
		this.size = [2, 2];
	}

	pathKey()
	{
		return flattenInto([], this.size);
	}

	buildParts()
	{
		const size = this.size;
		return [{path: new PathShape().addRect(-size[0] / 2, -size[1] / 2, size[0], size[1]), color: null}];
	}

	/**
	 * `texture`'s picture over the whole rectangle at opacity `alpha`, upright (the texture's 0..1 square is the
	 * rectangle, as VRML97's default mapping): the one textured geometry besides a Bitmap that needs no clip and no
	 * texture coordinates. A TextureTransform is not applied and repeatS / repeatT have nothing to repeat.
	 */
	drawTexture(ctx, host, texture, alpha)
	{
		const frame = host.textureFrame(texture);
		const width = Math.abs(this.size[0]), height = Math.abs(this.size[1]);
		if (!frame || alpha <= 0 || !(width > 0 && height > 0)) {
			return;
		}
		ctx.pushTransform();
		// The scene is Y up: flipped, the picture's first row is at the top.
		ctx.scale(1, -1);
		host.drawTexture(ctx, frame, -width / 2, -height / 2, width, height, alpha);
		ctx.popTransform();
	}

	/** The rectangle, grown by half the outline's width (miter joins: the outline's outer edge is a rectangle). */
	containsPoint(x, y, parts, lineWidth)
	{
		const reach = lineWidth / 2;
		return Math.abs(x) <= Math.abs(this.size[0]) / 2 + reach && Math.abs(y) <= Math.abs(this.size[1]) / 2 + reach;
	}
}

export class Circle extends X3DGeometryNode2D
{
	constructor()
	{
		super("Circle");
		this.radius = 1;
	}

	pathKey()
	{
		return [this.radius];
	}

	buildParts()
	{
		const r = this.radius;
		return [{path: new PathShape().addEllipse(0, 0, r, r), color: null}];
	}

	containsPoint(x, y, parts, lineWidth)
	{
		const r = Math.abs(this.radius) + lineWidth / 2;
		return x * x + y * y <= r * r;
	}
}

export class Curve2D extends X3DGeometryNode2D
{
	constructor()
	{
		super("Curve2D");
		this.point = null;		// Coordinate2D
		this.fineness = 0.5;
		this.type = [];			// segment types: 0 moveTo, 1 lineTo, 2 curveTo, 3 nextCurveTo
	}

	points()
	{
		return this.point instanceof Coordinate2D ? this.point.point : [];
	}

	pathKey()
	{
		const key = flattenCounted([], this.points());
		return flattenInto(key, this.type);
	}

	buildParts()
	{
		const builder = new PathBuilder();
		segmentsToPath(curve2dToSegments(this.points(), this.type, true), builder);
		return [{path: builder.path, color: null}];
	}
}

/**
 * GPAC's mpeg4_geometry_ifs2d.c: each coordIndex face (-1 ends one) is a closed polygon, no coordIndex is one
 * polygon of all points, colorPerVertex FALSE colors each face (colorIndex, else in order), a per-vertex
 * color is not drawn as a gradient (the material's color is used, as GPAC does).
 */
export class IndexedFaceSet2D extends X3DGeometryNode2D
{
	constructor()
	{
		super("IndexedFaceSet2D");
		this.color = null;		// Color
		this.coord = null;		// Coordinate2D
		this.texCoord = null;
		this.colorIndex = [];
		this.colorPerVertex = true;
		this.convex = true;
		this.coordIndex = [];
		this.texCoordIndex = [];
	}

	points()
	{
		return this.coord instanceof Coordinate2D ? this.coord.point : [];
	}

	colors()
	{
		return this.color instanceof Color ? this.color.color : null;
	}

	pathKey()
	{
		const key = flattenCounted([], this.points());
		flattenCounted(key, this.coordIndex);
		key.push(this.colorPerVertex === false ? 0 : 1);
		flattenCounted(key, this.colors() ?? []);
		return flattenInto(key, this.colorIndex);
	}

	/** One path of all faces, or one path per face when each face has its color. */
	buildParts()
	{
		const points = this.points();
		const coordIndex = this.coordIndex;
		const colors = this.colors();
		const colorIndex = this.colorIndex;

		const faces = [];
		if (coordIndex.length) {
			let face = [];
			for (const index of coordIndex) {
				if (index === -1) {
					if (face.length) {
						faces.push(face);
					}
					face = [];
				} else if (points[index]) {
					face.push(points[index]);
				}
			}
			if (face.length) {
				faces.push(face);
			}
		} else if (points.length) {
			faces.push(points);
		}

		const polygon = (builder, face) => {
			builder.moveTo(face[0][0], face[0][1]);
			for (let i = 1; i < face.length; ++i) {
				builder.lineTo(face[i][0], face[i][1]);
			}
			builder.close();
		};

		if (colors && coordIndex.length && this.colorPerVertex === false) {
			return faces.map((face, k) => {
				const builder = new PathBuilder();
				polygon(builder, face);
				return {path: builder.path, color: colors[colorIndex.length ? colorIndex[k] : k] ?? null};
			});
		}
		const builder = new PathBuilder();
		for (const face of faces) {
			polygon(builder, face);
		}
		// No coordIndex: the one polygon takes the first color (GPAC); a per-vertex color is not drawn.
		const single = colors && !coordIndex.length ? (colors[colorIndex.length ? colorIndex[0] : 0] ?? null) : null;
		return [{path: builder.path, color: single}];
	}
}

/** The points a coordIndex list names, one list per run between -1s; with no coordIndex, all the points as one run. */
function indexedRuns(points, coordIndex)
{
	const runs = [];
	if (coordIndex.length) {
		let run = [];
		for (const index of coordIndex) {
			if (index === -1) {
				if (run.length) {
					runs.push(run);
				}
				run = [];
			} else if (points[index]) {
				run.push(points[index]);
			}
		}
		if (run.length) {
			runs.push(run);
		}
	} else if (points.length) {
		runs.push(points);
	}
	return runs;
}

/**
 * Polylines, never filled and never closed (GPAC's mpeg4_geometry_ils2d.c: "NO close on ILS2D", "ILS2D are NEVER
 * filled"): each coordIndex run (-1 ends one) is a line through its points, no coordIndex is one line through all
 * points. The line is the material's (Material2D.look with paint "lines": the lineProps, else one pixel in
 * emissiveColor even when the material is filled).
 *
 * Color: with colorPerVertex FALSE, or fewer than two colors, each line takes one color, colorIndex[k] when there is a
 * colorIndex (else k), past the end the last color (ILS2D_Draw). The eventIns set_coordIndex and set_colorIndex
 * replace the fields (ILS2D_SetCoordIndex), which the base receive does.
 *
 * OBSERVED (systems-streams, Complete2D/IBM/IBMIndexedLineSet2D): a five-line star, each line its own coordIndex
 * run, colorPerVertex false with and without colorIndex "4 3 2 1 0"; the same star as one run "0 2 4 1 3 0" with
 * colorPerVertex true; materials unfilled, with and without LineProperties.
 * NOT BUILT: colorPerVertex TRUE. GPAC draws a line of exactly two points as a linear gradient between its two
 * colors and any longer line with no color of its own; here every per-vertex line is drawn in the material's line
 * color (the sample's per-vertex lines have six points, so they come out as GPAC's).
 */
export class IndexedLineSet2D extends X3DGeometryNode2D
{
	static paint = "lines";

	constructor()
	{
		super("IndexedLineSet2D");
		this.color = null;		// Color
		this.coord = null;		// Coordinate2D
		this.colorIndex = [];
		this.colorPerVertex = true;
		this.coordIndex = [];
	}

	points()
	{
		return this.coord instanceof Coordinate2D ? this.coord.point : [];
	}

	colors()
	{
		return this.color instanceof Color ? this.color.color : null;
	}

	pathKey()
	{
		const key = flattenCounted([], this.points());
		flattenCounted(key, this.coordIndex);
		key.push(this.colorPerVertex === false ? 0 : 1);
		flattenCounted(key, this.colors() ?? []);
		return flattenInto(key, this.colorIndex);
	}

	/** One path of all lines, or one path per line when each line has its color. */
	buildParts()
	{
		const runs = indexedRuns(this.points(), this.coordIndex);
		const colors = this.colors();
		const colorIndex = this.colorIndex;
		const polyline = (builder, run) => {
			builder.moveTo(run[0][0], run[0][1]);
			for (let i = 1; i < run.length; ++i) {
				builder.lineTo(run[i][0], run[i][1]);
			}
		};
		if (colors && colors.length && (this.colorPerVertex === false || colors.length < 2)) {
			return runs.map((run, k) => {
				const builder = new PathBuilder();
				polyline(builder, run);
				const index = colorIndex.length && colorIndex[k] >= 0 ? colorIndex[k] : k;
				return {path: builder.path, color: colors[Math.min(index, colors.length - 1)]};
			});
		}
		const builder = new PathBuilder();
		for (const run of runs) {
			polyline(builder, run);
		}
		return [{path: builder.path, color: null}];
	}
}

/**
 * Points, each drawn as a square of one device pixel whatever the transforms (GPAC's get_point_size in
 * mpeg4_geometry_2d.c: sqrt(2) / the length of the matrix's (a + b, c + d)), never outlined and never picked
 * (TraversePointSet2D returns on TRAVERSE_PICK). The squares are centered on the points.
 *
 * Color: each point takes its color when the Color node has one for every point, else all take the material's
 * emissiveColor at 1 - transparency, filled or not (Material2D.look with paint "points").
 *
 * OBSERVED (Complete2D/IBM/IBMPointSet2D): two point sets over one Coordinate2D, one with a Color per point, both
 * under <Material2D emissiveColor="0 1 1"/> (not filled); meant to show.
 * OUTLIER: GPAC's 2D raster (PointSet2D_Draw, drawable_get_aspect_2d_mpeg4) writes a point's color into the LINE
 * color while it draws only the fill, and gives an unfilled material's points black: by it both sets of the sample
 * are black. INFERRED, from memory of VRML97 6.36 PointSet and not re-read (the Color node's colors, else the
 * material's emissiveColor); GPAC's own 3D path takes the colors (mesh_new_ps).
 */
export class PointSet2D extends X3DGeometryNode2D
{
	static paint = "points";

	constructor()
	{
		super("PointSet2D");
		this.color = null;		// Color
		this.coord = null;		// Coordinate2D
		this._pointSize = 1;	// one device pixel in this node's space, as of the last draw
	}

	points()
	{
		return this.coord instanceof Coordinate2D ? this.coord.point : [];
	}

	colors()
	{
		return this.color instanceof Color ? this.color.color : null;
	}

	/** The side of one device pixel under the transform the points are drawn with. */
	bindHost(host, ctx)
	{
		// Column-major: x' = m0 x + m3 y + m6, y' = m1 x + m4 y + m7.
		const m = ctx.globalTransform;
		const length = Math.hypot(m[0] + m[3], m[1] + m[4]);
		this._pointSize = length > 0 ? Math.SQRT2 / length : host.onePixel;
	}

	pathKey()
	{
		const key = [this._pointSize];
		flattenCounted(key, this.points());
		return flattenInto(key, this.colors() ?? []);
	}

	/** One path of all squares, or one path per color when each point has its color. */
	buildParts()
	{
		const points = this.points();
		const colors = this.colors();
		const half = this._pointSize / 2;
		const square = (builder, p) => {
			builder.moveTo(p[0] - half, p[1] - half);
			builder.lineTo(p[0] + half, p[1] - half);
			builder.lineTo(p[0] + half, p[1] + half);
			builder.lineTo(p[0] - half, p[1] + half);
			builder.close();
		};
		if (colors && points.length && colors.length >= points.length) {
			const byColor = new Map();	// "r,g,b" -> {builder, color}
			points.forEach((p, i) => {
				const name = colors[i].join(",");
				let entry = byColor.get(name);
				if (!entry) {
					byColor.set(name, entry = {builder: new PathBuilder(), color: colors[i]});
				}
				square(entry.builder, p);
			});
			return [...byColor.values()].map((entry) => ({path: entry.builder.path, color: entry.color}));
		}
		const builder = new PathBuilder();
		for (const p of points) {
			square(builder, p);
		}
		return [{path: builder.path, color: null}];
	}

	containsPoint(x, y, parts, lineWidth)
	{
		return false;
	}
}
