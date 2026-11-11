// BIFS geometry -> neutral path segments. Kept dependency-free (no gfx/effects) so
// it's unit-testable in isolation; players/x3d/X3DTitleNode.js turns these segments
// into a gfx PathShape (moveTo/lineTo/cubicTo/close).
//
// The Curve2D `type` field (MFInt32) drives how the `point` list (an array of
// [x,y] pairs from a Coordinate2D) forms path segments. Codes per ISO/IEC
// 14496-1 section 9.4.2.36 and Sigurd Lerstad's own renderer (FirstProject2 X3DNode.cpp
// draw_curve): 0=moveTo, 1=lineTo, 2=cubic (2 control pts + endpoint),
// 3=reflected cubic (1 control pt + endpoint; first control = reflection of the
// previous curve's last control across the current point).
//
// Segment ops: {op:"M",x,y} {op:"L",x,y} {op:"C",x1,y1,x2,y2,x,y} {op:"Z"}.

const POINT = (pts, i) => (i < pts.length ? pts[i] : null);

/**
 * @param {Array<[number,number]>} pts  Coordinate2D.point (array of [x,y])
 * @param {number[]} types              Curve2D.type (segment codes)
 * @param {boolean} [close=true]        close each subpath (filled shapes; the tiger is filled)
 * @returns {Array<object>} neutral path segments
 */
export function curve2dToSegments(pts, types, close = true) {
	const seg = [];
	if (!Array.isArray(pts) || pts.length === 0) return seg;
	// No type info -> nothing drawable, matching the renderer's `if (type.size() > 0)`
	// guard (X3DNode.cpp draw_curve). With a non-empty-but-short type, exhausted codes
	// default to 0 (MoveTo), also matching the renderer.
	if (!types || types.length === 0) return seg;

	let i = 0, j = 0;
	let cur = pts[i++];
	let prevC2 = null;                       // last cubic's 2nd control point (for reflected cubics)
	seg.push({ op: "M", x: cur[0], y: cur[1] });

	while (i < pts.length) {
		const t = j < types.length ? types[j++] : 0;
		if (t === 0) {                         // MoveTo -- start a new subpath
			const N = POINT(pts, i); if (!N) break; i += 1;
			if (close) seg.push({ op: "Z" });
			seg.push({ op: "M", x: N[0], y: N[1] });
			cur = N; prevC2 = null;
		} else if (t === 1) {                  // LineTo
			const N = POINT(pts, i); if (!N) break; i += 1;
			seg.push({ op: "L", x: N[0], y: N[1] });
			cur = N; prevC2 = null;
		} else if (t === 2) {                  // CurveTo -- cubic with two control points
			const C1 = POINT(pts, i), C2 = POINT(pts, i + 1), N = POINT(pts, i + 2);
			if (!C1 || !C2 || !N) break; i += 3;
			seg.push({ op: "C", x1: C1[0], y1: C1[1], x2: C2[0], y2: C2[1], x: N[0], y: N[1] });
			cur = N; prevC2 = C2;
		} else if (t === 3) {                  // NextCurveTo -- cubic, 1st control reflected
			const C2 = POINT(pts, i), N = POINT(pts, i + 1);
			if (!C2 || !N) break; i += 2;
			const c1x = prevC2 ? 2 * cur[0] - prevC2[0] : cur[0];
			const c1y = prevC2 ? 2 * cur[1] - prevC2[1] : cur[1];
			seg.push({ op: "C", x1: c1x, y1: c1y, x2: C2[0], y2: C2[1], x: N[0], y: N[1] });
			cur = N; prevC2 = C2;
		} else {
			throw new Error(`BIFS Curve2D: unknown segment type code ${t}`);
		}
	}
	if (close) seg.push({ op: "Z" });
	return seg;
}

/** Pull the [x,y] point list out of a Curve2D node's Coordinate2D `point` field. */
export function curve2dPoints(curve2dNode) {
	return curve2dNode?.fields?.point?.fields?.point || [];
}

/** Apply neutral path segments to a gfx PathBuilder (or anything with moveTo/lineTo/cubicTo/close). */
export function segmentsToPath(segments, builder) {
	for (const s of segments) {
		if (s.op === "M") builder.moveTo(s.x, s.y);
		else if (s.op === "L") builder.lineTo(s.x, s.y);
		else if (s.op === "C") builder.cubicTo(s.x1, s.y1, s.x2, s.y2, s.x, s.y);
		else if (s.op === "Z") builder.close?.();
	}
	return builder;
}
