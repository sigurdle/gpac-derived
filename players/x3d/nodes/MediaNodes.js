/*
** The BIFS media nodes: MovieTexture, ImageTexture, PixelTexture, Bitmap, Sound2D, AudioClip, AudioSource, and Background2D.
**
** A MovieTexture names its movie by object descriptor (url [{od: N}]); the host (X3DTitleNode) resolves that to a video
** track of the file (`doc.objectTracks`, `doc.textureTracks`) and gives the texture its track with setMedia. The
** texture says which frame of its track it shows (wantedFrame); the host fetches the frames and hands them to the
** drawing as opaque frame records (host.textureFrame). A Bitmap and a Rectangle draw a texture; a texture on any other
** geometry is reported skipped by the Shape. An ImageTexture goes the same way: its still is a track of one sample
** (a JPEG or PNG the reader decodes by the track's esds object type), shown as that track's frame 0.
**
** MovieTexture's time rules are VRML97's (ISO/IEC 14772-1 6.28 and 4.6.9), as GPAC's movietexture_update_time
** (src/compositor/mpeg4_textures.c) applies them: see movieMediaTime. Bitmap follows GPAC's mpeg4_bitmap.c.
**
** Sound: an AudioClip or AudioSource names an audio track by object descriptor, as a texture its video track; the host
** binds it (setMedia) and plays it (X3DAudio.js). The node says whether it sounds and where in its track it is, by
** scene time; a Sound2D gives the source in its `source` field its gain. The sound section below has the rules, and
** what is observed in a sample and what is inferred.
** Background2D is bindable: the host draws its color behind everything, wherever it is in the tree.
** Defaults: GPAC's mpeg4_nodes.c (*_Create).
*/

import {X3DNode} from "./X3DNode.js";

/** The scene time a title starts at: a start in the past starts a movie then (X3DTitleNode plays from 0). */
const SCENE_START = 0;

/**
 * Where a MovieTexture is in its movie at scene time `t` (seconds), and whether it is active: VRML97 6.28 / 4.6.9.
 * - It becomes active at startTime, or when the scene starts if startTime is earlier (GPAC activates it on its first
 *   time update and plays from scene time - startTime, so tracks2.mp4's startTime -1 starts its movie 1 s in).
 * - stopTime counts only when it is later than startTime; at stopTime the movie stops, the frame it reached stays.
 * - One cycle is duration / |speed|; looped, the movie time is the elapsed time modulo a cycle (6.28:
 *   t = (now - startTime) modulo (duration/speed), and duration - that for a negative speed); not looped, it stops
 *   after one cycle on its last frame.
 * - Inactive before it starts (or if it would stop before it starts): frame 0, the last frame for a negative speed;
 *   speed 0 always shows frame 0.
 * Stateless in `t`, so a seek backward shows what playing up to it would have.
 * @returns {{active: boolean, mediaTime: number}} mediaTime in seconds of the movie, 0..duration
 */
export function movieMediaTime(t, startTime, stopTime, loop, speed, duration)
{
	const first = speed < 0 ? duration : 0;
	if (speed === 0 || !(duration > 0)) {
		return {active: t >= Math.max(startTime, SCENE_START) && !(stopTime > startTime && t >= stopTime), mediaTime: 0};
	}
	const cycle = duration / Math.abs(speed);
	let end = stopTime > startTime ? stopTime : Infinity;
	if (!loop) {
		end = Math.min(end, startTime + cycle);
	}
	const activation = Math.max(startTime, SCENE_START);
	if (t < activation || activation >= end) {
		return {active: false, mediaTime: first};
	}
	const elapsed = Math.min(t, end) - startTime;
	// Not looped, the end of the cycle holds the last frame (the modulo would wrap it to the first).
	const phase = !loop && elapsed >= cycle ? cycle : elapsed % cycle;
	const along = phase * Math.abs(speed);
	return {active: t < end, mediaTime: speed > 0 ? along : duration - along};
}

/** The index of the last frame whose time is at or before `time` (frameTimes ascending, from 0). */
function frameAt(frameTimes, time)
{
	let lo = 0;
	let hi = frameTimes.length - 1;
	if (hi < 0) {
		return 0;
	}
	while (lo < hi) {
		const mid = (lo + hi + 1) >> 1;
		if (frameTimes[mid] <= time + 1e-9) {
			lo = mid;
		} else {
			hi = mid - 1;
		}
	}
	return lo;
}

/**
 * The object descriptor a media node's url names, or null (a url that is a file name, or none). A BIFS url is
 * [{od: N}]; a VRML or X3D url lists file names, and the one whose file the reader opened beside the scene is
 * {od: N, url: "..."} among them (fileformats/helpers/vrml/VrmlExternalFiles.js): the first entry with a descriptor.
 */
function urlObjectDescriptor(url)
{
	for (const entry of url) {
		if (entry !== null && typeof entry === "object" && typeof entry.od === "number") {
			return entry.od;
		}
	}
	return null;
}

export class Background2D extends X3DNode
{
	constructor()
	{
		super("Background2D");
		this.backColor = [0, 0, 0];
		this.url = [];
	}
}

export class MovieTexture extends X3DNode
{
	/** Ticks to follow scene time: its movie time, isActive and duration_changed. */
	static ticks = true;

	constructor()
	{
		super("MovieTexture");
		this.loop = false;
		this.speed = 1;
		this.startTime = 0;
		this.stopTime = 0;
		this.url = [];
		this.repeatS = true;
		this.repeatT = true;
		this._trackId = null;		// the video track it shows (setMedia), null: none resolved
		this._media = null;			// that track's {duration, frameTimes} (QTReader._bifsVideoTracks)
		this._active = false;		// isActive, as last sent
		this._mediaTime = 0;		// seconds into the movie
		this._durationSent = false;
	}

	/** The object descriptor its url names, or null (a url that is a file name, or none). */
	objectDescriptor()
	{
		return urlObjectDescriptor(this.url);
	}

	setMedia(trackId, media)
	{
		this._trackId = trackId;
		this._media = media;
	}

	tick(scene, t)
	{
		const duration = this._media ? this._media.duration : 0;
		if (this._media && !this._durationSent) {
			// 6.28: sent as soon as the movie is loaded; GPAC sends it with the first frame.
			this._durationSent = true;
			scene.emit(this, "duration_changed", duration, t);
		}
		const state = movieMediaTime(t, this.startTime, this.stopTime, this.loop, this.speed, duration);
		this._mediaTime = state.mediaTime;
		if (state.active !== this._active) {
			this._active = state.active;
			scene.emit(this, "isActive", state.active, t);
		}
	}

	/** 4.6.9: set_startTime is ignored while active; 6.28: so is set_speed. A command's write is stored (X3DNode.receive). */
	receive(name, value, scene, time, isCommand = false)
	{
		if (!isCommand && this._active && (name === "startTime" || name === "speed")) {
			return;
		}
		super.receive(name, value, scene, time);
	}

	/** The frame of its track it shows now. */
	wantedFrame()
	{
		return this._media ? frameAt(this._media.frameTimes, this._mediaTime) : 0;
	}
}

/** A still: the one picture of its track, which the host fetches as a movie's frame 0. */
export class ImageTexture extends X3DNode
{
	constructor()
	{
		super("ImageTexture");
		this.url = [];
		this.repeatS = true;
		this.repeatT = true;
		this._trackId = null;		// the track that holds the picture (setMedia), null: none resolved
	}

	objectDescriptor()
	{
		return urlObjectDescriptor(this.url);
	}

	setMedia(trackId, media)
	{
		this._trackId = trackId;
	}

	wantedFrame()
	{
		return 0;
	}
}

/**
 * A picture given in the scene itself: `image` is the decoder's SFImage {width, height, components, pixels}, the
 * pixels `components` bytes each (1 gray, 2 gray + alpha, 3 RGB, 4 RGBA; GPAC's pixeltexture_update in
 * mpeg4_textures.c takes them so), rows from the BOTTOM up (GPAC reverts the rows; VRML97's SFImage is left to right,
 * bottom to top). The host makes the bitmap (X3DPixelTextures.js) from rgba() and draws it as a still.
 *
 * OBSERVED (Complete2D/IBM/IBMPixelTextureRGBAlpha, ...GrayAlpha, ...RGB, ...Gray): a 2 x 3 image on a Rectangle
 * 100 x 150, under filled materials of several colors and transparencies.
 * INFERRED: in a two-component pixel the first byte is the gray and the second the alpha (VRML97's SFImage, from
 * memory; the sample's "0x80ff" then is gray 0x80, opaque). GPAC names that layout GF_PIXEL_ALPHAGREY, which may
 * mean the other order: not checked against a rendering.
 * NOT BUILT: `image` is not an eventIn in this node table, so the picture changes only when a command replaces the
 * field (the host sees the new image object and rebuilds). The picture is drawn smoothed, as a movie frame is; a
 * 2 x 3 image stretched over a Rectangle shows gradients where GPAC's software raster may show six flat cells.
 */
export class PixelTexture extends X3DNode
{
	constructor()
	{
		super("PixelTexture");
		this.image = {width: 0, height: 0, components: 0, pixels: new Uint8Array(0)};
		this.repeatS = true;
		this.repeatT = true;
	}

	/**
	 * The image as straight (not premultiplied) RGBA8, the TOP row first, or null for an empty image.
	 * @returns {{width: number, height: number, hasAlpha: boolean, data: Uint8Array} | null}
	 */
	rgba()
	{
		const {width, height, components, pixels} = this.image;
		if (!(width > 0 && height > 0) || components < 1 || components > 4 || pixels.length < width * height * components) {
			return null;
		}
		const data = new Uint8Array(width * height * 4);
		for (let row = 0; row < height; ++row) {
			let from = (height - 1 - row) * width * components;
			let to = row * width * 4;
			for (let x = 0; x < width; ++x, from += components, to += 4) {
				if (components < 3) {
					data[to] = data[to + 1] = data[to + 2] = pixels[from];
					data[to + 3] = components === 2 ? pixels[from + 1] : 255;
				} else {
					data[to] = pixels[from];
					data[to + 1] = pixels[from + 1];
					data[to + 2] = pixels[from + 2];
					data[to + 3] = components === 4 ? pixels[from + 3] : 255;
				}
			}
		}
		return {width, height, hasAlpha: components === 2 || components === 4, data};
	}
}

/**
 * GPAC's mpeg4_bitmap.c: a rectangle centered on the origin, the texture's pixel size times `scale` (a negative
 * component: 1), in scene units (pixel metrics: pixels; otherwise divided by the half of the smaller side). It is
 * never rotated (draw_bitmap_2d drops the transform's rotation and skew terms, keeping its scale and translation).
 * Drawn only with a texture whose frame has arrived; nothing without one. Picked in that rectangle (GPAC's
 * TraverseBitmap picks the rectangle path Bitmap_BuildGraph made, under the whole transform: a rotation the drawing
 * drops still turns the picked rectangle).
 */
export class Bitmap extends X3DNode
{
	constructor()
	{
		super("Bitmap");
		this.scale = [-1, -1];
		this._drawnSize = null;		// [width, height] of the rectangle of the last draw, in scene units; null: not drawn yet
	}

	/** True if (x, y) of the Bitmap's space is in the rectangle its picture was last drawn in. */
	containsPoint(x, y)
	{
		const size = this._drawnSize;
		return size !== null && Math.abs(x) <= size[0] / 2 && Math.abs(y) <= size[1] / 2;
	}

	/** Draw `texture` at opacity `alpha` (the appearance's: Appearance.textureAlpha). */
	drawTexture(ctx, host, texture, alpha)
	{
		const frame = host.textureFrame(texture);
		if (!frame || alpha <= 0) {
			return;
		}
		const sx = this.scale[0] < 0 ? 1 : this.scale[0];
		const sy = this.scale[1] < 0 ? 1 : this.scale[1];
		const width = frame.bitmap.width * sx * host.onePixel;
		const height = frame.bitmap.height * sy * host.onePixel;
		if (!(width > 0 && height > 0)) {
			return;
		}
		this._drawnSize = [width, height];
		ctx.pushTransform();
		host.unrotate(ctx);
		// The scene is Y up: flipped, the picture's first row is at the top.
		ctx.scale(1, -1);
		host.drawTexture(ctx, frame, -width / 2, -height / 2, width, height, alpha);
		ctx.popTransform();
	}
}

// ---- sound ------------------------------------------------------------------
// The time rule is MovieTexture's (movieMediaTime): VRML97 gives AudioClip (6.2) and MovieTexture (6.28) the same
// time-dependent node rules (4.6.9), with pitch in the place of speed (pitch 2 plays twice as fast, an octave up).
//
// OBSERVED in the conformance scenes (systems-streams/xmt-a):
//   - 20 Philips scenes have <AudioSource startTime="-1" stopTime="-1"> and nothing that routes to it (cdrA-AAC is that
//     source and no picture), and tracks2 has <AudioClip loop="true" startTime="-1" stopTime="-1"> beside a MovieTexture
//     with the same times: a start before the scene's is meant to sound from the scene's start.
//   - tracks2 routes one TouchSensor's touchTime to the clip's and the movie's stopTime, another's to their startTime.
//   - Sound2D: intensity 1 or 0.5, spatialize mostly false, location 0 0.
// OUTLIER: GPAC (src/compositor/mpeg4_audio.c, audioclip_update_time / audiosource_update_time) never activates a
// sound whose startTime is negative, though its movietexture_update_time (mpeg4_textures.c) plays such a movie; by it
// tracks2's movie would play and its sound stay silent until the start button, and cdrA-AAC would play nothing.
// INFERRED (no sample shows the difference): a sound that starts before the scene is that far into its track at the
// scene's start, as the movie beside it (GPAC starts a sound at its beginning whenever it activates); an AudioSource
// has no loop field and plays its track once (GPAC: gf_mo_get_loop(stream, GF_FALSE)); its rate is `speed`, as GPAC
// sets it, and its `pitch` is not applied (MPEG-4 means a pitch change at the same speed); set_startTime is ignored
// while it sounds, and for an AudioSource set_speed (GPAC latches both only while inactive), for an AudioClip
// set_pitch as MovieTexture's set_speed.
// Not played: an AudioSource's children, numChan and phaseGroup; AudioBuffer, AudioSwitch, AudioMix, AudioDelay and
// AudioFX (a Sound2D over one reports it skipped). The 3D Sound node is not built (the decoder has no field table
// for it).

/** What AudioClip and AudioSource share: the track they play and where they are in it. */
class SoundSourceNode extends X3DNode
{
	/** Ticks to follow scene time: whether it sounds, and its place in its track. */
	static ticks = true;

	constructor(typeName)
	{
		super(typeName);
		this._trackId = null;		// the audio track it plays (setMedia), null: none resolved
		this._media = null;			// that track's {source, sampleRate, nChannels, nSamples, duration} (QTReader._bifsSoundTracks)
		this._active = false;		// it sounds at the scene time of the last tick
		this._mediaTime = 0;		// seconds into its track then
	}

	/** The object descriptor its url names, or null (a url that is a file name, or none). */
	objectDescriptor()
	{
		return urlObjectDescriptor(this.url);
	}

	setMedia(trackId, media)
	{
		this._trackId = trackId;
		this._media = media;
	}

	/** Media seconds per second of scene time. */
	rate()
	{
		return 1;
	}

	/** True if it starts over at the end of its track. */
	loops()
	{
		return false;
	}

	/** Follow scene time `t`; true if it became active or inactive. */
	_follow(t)
	{
		const duration = this._media ? this._media.duration : 0;
		const state = movieMediaTime(t, this.startTime, this.stopTime, this.loops(), this.rate(), duration);
		this._mediaTime = state.mediaTime;
		if (state.active === this._active) {
			return false;
		}
		this._active = state.active;
		return true;
	}
}

export class AudioClip extends SoundSourceNode
{
	constructor()
	{
		super("AudioClip");
		this.description = "";
		this.loop = false;
		this.pitch = 1;
		this.startTime = 0;
		this.stopTime = 0;
		this.url = [];
		this._durationSent = false;
	}

	rate()
	{
		return this.pitch;
	}

	loops()
	{
		return this.loop;
	}

	tick(scene, t)
	{
		if (this._media && !this._durationSent) {
			// 6.2: sent once the sound is loaded, in seconds at pitch 1.
			this._durationSent = true;
			scene.emit(this, "duration_changed", this._media.duration, t);
		}
		if (this._follow(t)) {
			scene.emit(this, "isActive", this._active, t);
		}
	}

	/** 4.6.9: set_startTime is ignored while active; set_pitch as MovieTexture's set_speed. */
	receive(name, value, scene, time, isCommand = false)
	{
		if (!isCommand && this._active && (name === "startTime" || name === "pitch")) {
			return;
		}
		super.receive(name, value, scene, time);
	}
}

/** MPEG-4's stream source (no isActive, no loop); its children (other audio nodes mixed in) are not played. */
export class AudioSource extends SoundSourceNode
{
	constructor()
	{
		super("AudioSource");
		this.children = [];
		this.url = [];
		this.pitch = 1;
		this.speed = 1;
		this.startTime = 0;
		this.stopTime = 0;
		this.numChan = 1;
		this.phaseGroup = [];
	}

	rate()
	{
		return this.speed;
	}

	tick(scene, t)
	{
		this._follow(t);
	}

	receive(name, value, scene, time, isCommand = false)
	{
		if (!isCommand && this._active && (name === "startTime" || name === "speed")) {
			return;
		}
		super.receive(name, value, scene, time);
	}
}

/**
 * Gives its source its gain: `intensity` on every channel, as GPAC's SND2D_GetChannelVolume (mpeg4_sound.c).
 * `location` and `spatialize` are not applied: the sound is not panned. A Sound2D that is not in the drawn tree
 * (an unchosen Switch choice) is silent while its source's time runs on (GPAC's switched_off mute).
 */
export class Sound2D extends X3DNode
{
	constructor()
	{
		super("Sound2D");
		this.intensity = 1;
		this.location = [0, 0];
		this.source = null;
		this.spatialize = true;
	}

	/** The source it plays, or null: none, or an audio node that is not played. */
	soundSource()
	{
		return this.source instanceof SoundSourceNode ? this.source : null;
	}

	draw(ctx, host)
	{
		if (this.source && !this.soundSource()) {
			host.skip(this.source.typeName);
		}
	}
}

/** True for a node that plays an audio track (AudioClip, AudioSource). */
export function isSoundSource(node)
{
	return node instanceof SoundSourceNode;
}
