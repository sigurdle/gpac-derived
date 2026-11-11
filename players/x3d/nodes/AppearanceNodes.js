/*
** The BIFS Shape and its appearance: Shape, Appearance, Material2D, LineProperties. Defaults: GPAC's
** mpeg4_nodes.c (*_Create).
**
** The look follows GPAC's drawable_get_aspect_2d_mpeg4 (src/compositor/drawable.c): fill = emissiveColor at
** 1 - transparency when filled; without lineProps an unfilled shape is outlined one pixel wide in
** emissiveColor; LineProperties gives lineColor and width; flat caps, miter joins, miter limit 4.
** Shapes go onto the GPU the way SWFNode's do: a gfx PathShape drawn with Shape.draw(ctx, style), the
** stencil-and-cover fill and the PathKit stroke expansion.
**
** A Bitmap and a Rectangle draw their appearance's MovieTexture, ImageTexture or PixelTexture (MediaNodes.js): the
** Bitmap at the picture's size, the Rectangle with the picture as its fill (GPAC: the texture takes the fill
** color's place, the outline stays as the material gives it; a textured, unfilled material with no lineProps
** keeps its one-pixel outline, which GPAC's own comment calls unclear in the spec). A texture on any other
** geometry is skipped (not yet: it needs a clip to the path), and so is a TextureTransform.
*/

import {X3DNode} from "./X3DNode.js";
import {X3DGeometryNode2D, Rectangle} from "./GeometryNodes.js";
import {Bitmap, ImageTexture, MovieTexture, PixelTexture} from "./MediaNodes.js";

/** True for a texture that has a picture to draw: a PixelTexture, or a movie or still bound to its track. */
function hasPicture(texture)
{
	return texture instanceof PixelTexture ||
		((texture instanceof MovieTexture || texture instanceof ImageTexture) && texture._trackId !== null);
}

/** Material2D's emissiveColor default, also GPAC's line color with no material. */
const DEFAULT_EMISSIVE = [0.8, 0.8, 0.8];

function rgba(rgb, alpha)
{
	return [rgb[0], rgb[1], rgb[2], alpha];
}

function sameNumbers(a, b)
{
	if (a.length !== b.length) {
		return false;
	}
	for (let i = 0; i < a.length; ++i) {
		if (a[i] !== b[i]) {
			return false;
		}
	}
	return true;
}

/** No Material2D: a one-pixel outline in the default emissive color, no fill; points in that color. */
function defaultLook(onePixel, paint)
{
	if (paint === "points") {
		return {fill: rgba(DEFAULT_EMISSIVE, 1), line: null, width: 0};
	}
	return {fill: null, line: rgba(DEFAULT_EMISSIVE, 1), width: onePixel};
}

export class LineProperties extends X3DNode
{
	constructor()
	{
		super("LineProperties");
		this.lineColor = [0, 0, 0];
		this.lineStyle = 0;
		this.width = 1;
	}
}

export class Material2D extends X3DNode
{
	constructor()
	{
		super("Material2D");
		this.emissiveColor = [...DEFAULT_EMISSIVE];
		this.filled = false;
		this.lineProps = null;		// LineProperties
		this.transparency = 0;
	}

	/**
	 * The fill color, line color and line width: colors are [r, g, b, a], or null for none. `paint` is the
	 * geometry's (X3DGeometryNode2D.paint): "lines" are never filled, so without lineProps they are one pixel in
	 * emissiveColor even under a filled material (GPAC's TAG_MPEG4_IndexedLineSet2D case); "points" are always filled
	 * in emissiveColor and never outlined (GeometryNodes.js PointSet2D names where this leaves GPAC).
	 */
	look(onePixel, paint)
	{
		const alpha = 1 - this.transparency;
		const color = this.emissiveColor;
		if (paint === "points") {
			return {fill: rgba(color, alpha), line: null, width: 0};
		}
		const fill = this.filled && paint !== "lines" ? rgba(color, alpha) : null;
		const lineProps = this.lineProps;
		if (!lineProps) {
			// One pixel in emissiveColor, unless the shape is filled (with any alpha) or fully transparent.
			const outline = alpha > 0 && !fill;
			return {fill, line: outline ? rgba(color, alpha) : null, width: outline ? onePixel : 0};
		}
		if (lineProps instanceof LineProperties) {
			return {fill, line: rgba(lineProps.lineColor, alpha), width: lineProps.width};
		}
		return {fill, line: null, width: 0};
	}
}

export class Appearance extends X3DNode
{
	constructor()
	{
		super("Appearance");
		this.material = null;			// Material2D
		this.texture = null;			// MovieTexture, ImageTexture, PixelTexture
		this.textureTransform = null;
	}

	look(onePixel, paint)
	{
		return this.material instanceof Material2D ? this.material.look(onePixel, paint) : defaultLook(onePixel, paint);
	}

	/**
	 * A texture's opacity: GPAC's (visual_manager_2d_draw.c) is the fill color's alpha, else the line color's, which
	 * with a Material2D are both 1 - transparency; without one the line color, opaque.
	 */
	textureAlpha()
	{
		return this.material instanceof Material2D ? 1 - this.material.transparency : 1;
	}
}

export class Shape extends X3DNode
{
	constructor()
	{
		super("Shape");
		this.appearance = null;		// Appearance
		this.geometry = null;		// a geometry node
		this._paths = null;			// {geometry, key, parts}: the geometry's paths and paint items
		this._onePixel = 0;			// the host's one pixel at the last draw: the default outline's width, for picking
	}

	draw(ctx, host)
	{
		const geometry = this.geometry;
		const appearance = this.appearance instanceof Appearance ? this.appearance : null;
		if (!geometry) {
			return;
		}
		const texture = appearance ? appearance.texture : null;
		let textured = false;
		if (texture) {
			if (!hasPicture(texture) || !(geometry instanceof Bitmap || geometry instanceof Rectangle)) {
				// A texture with no track, a texture on a Circle, a Curve2D...: not drawn yet.
				host.skip(texture.typeName);
				return;
			}
			geometry.drawTexture(ctx, host, texture, appearance.textureAlpha());
			if (geometry instanceof Bitmap) {
				return;
			}
			// A Rectangle: the picture is its fill; its outline is drawn below as without a texture.
			textured = true;
			if (appearance.textureTransform) {
				host.skip(appearance.textureTransform.typeName);
			}
		}
		if (geometry instanceof Bitmap) {
			return;	// GPAC draws a Bitmap only with a texture
		}
		if (!(geometry instanceof X3DGeometryNode2D)) {
			host.skip(geometry.typeName);
			return;
		}

		geometry.bindHost(host, ctx);
		this._onePixel = host.onePixel;
		const parts = this.paths(geometry);
		const paint = geometry.constructor.paint;
		const look = appearance ? appearance.look(host.onePixel, paint) : defaultLook(host.onePixel, paint);
		for (const part of parts) {
			let fill = textured ? null : look.fill;
			let line = look.line;
			if (part.color) {
				// A face's own color takes the fill's place, or the line's when the face is not filled (GPAC).
				if (fill) {
					fill = rgba(part.color, fill[3]);
				} else if (line) {
					line = rgba(part.color, line[3]);
				}
			}
			if (fill && fill[3] > 0) {
				part.fillItem.color = fill;
				part.path.draw(ctx, part.fillItem);
			}
			if (line && line[3] > 0 && look.width > 0) {
				part.strokeItem.color = line;
				part.strokeItem.width = look.width;
				part.path.draw(ctx, part.strokeItem);
			}
		}
	}

	/**
	 * The geometry's paths and paint items, rebuilt when its numbers change (a field the runtime wrote). The
	 * paint items live as long as the paths: Shape.draw caches a stroke's expansion on its item.
	 */
	paths(geometry)
	{
		const key = geometry.pathKey();
		const cached = this._paths;
		if (cached && cached.geometry === geometry && sameNumbers(cached.key, key)) {
			return cached.parts;
		}
		const parts = geometry.buildParts().map((p) => ({
			path: p.path,
			color: p.color,
			fillItem: {type: "solid", color: [0, 0, 0, 1], isFill: true},
			strokeItem: {type: "solid", color: [0, 0, 0, 1], isFill: false, width: 1, cap: "butt", join: "miter", miterLimit: 4},
		}));
		this._paths = {geometry, key, parts};
		return parts;
	}

	/**
	 * Hit when the point is inside the geometry, textured or not, or on its outline where it has one (GPAC's
	 * vrml_drawable_pick: the path's area regardless of the look, then the outline when the pen has a width; the
	 * default one-pixel outline is as wide as it was at the last draw). A Bitmap is hit in its picture's rectangle.
	 */
	pick(x, y, sensors, sensorPoint)
	{
		const geometry = this.geometry;
		if (geometry instanceof Bitmap) {
			return geometry.containsPoint(x, y) ? {shape: this, sensors, sensorPoint} : null;
		}
		if (!(geometry instanceof X3DGeometryNode2D)) {
			return null;
		}
		const paint = geometry.constructor.paint;
		const look = this.appearance instanceof Appearance ? this.appearance.look(this._onePixel, paint) : defaultLook(this._onePixel, paint);
		const lineWidth = look.line && look.width > 0 ? look.width : 0;
		return geometry.containsPoint(x, y, this.paths(geometry), lineWidth) ? {shape: this, sensors, sensorPoint} : null;
	}
}
