// MPEG-4 Object Descriptor stream decoder (the 'odsm' track). A scene's
// MovieTexture/ImageTexture/AudioSource fields carry an `url: [{od: N}]`; the OD
// stream maps each ObjectDescriptor-ID N to an elementary stream -- either an
// ES_ID_Ref (an index into the OD track's `mpod` track reference) or an ES_ID_Inc
// (a direct track ID). Ported from FirstProject2 ODDecoder.cpp (byte-oriented
// descriptors). Fail-soft: returns whatever it could parse.
//
// @param {Uint8Array} bytes  one OD access unit
// @returns {Map<number, {esIdRef?: number, trackId?: number}>} ODID -> ES reference

export function decodeODFrame(bytes) {
	const map = new Map();
	if (!bytes || !bytes.length) return map;
	let pos = 0;
	const end = bytes.length;
	const u8 = () => bytes[pos++];
	const u16 = () => (u8() << 8) | u8();
	const u32 = () => ((u8() << 24) | (u8() << 16) | (u8() << 8) | u8()) >>> 0;
	// expandable descriptor length (7 bits/byte, high bit = continue), capped at 4 bytes
	const readLen = () => { let len = 0, b, n = 0; do { b = u8(); len = (len << 7) | (b & 0x7f); } while ((b & 0x80) && ++n < 4); return len; };

	try {
		while (pos < end) {
			const tag = u8(), len = readLen(), stop = pos + len;
			if (tag === 0x01) {                         // ObjectDescrUpdate command
				while (pos < stop) {
					const t2 = u8(), l2 = readLen(), s2 = pos + l2;
					if (t2 === 0x11 || t2 === 0x10) {       // MP4_OD / MP4_IOD (InitialObjectDescriptor)
						if (t2 === 0x10) { u8(); u8(); }      // IOD: ODProfileLevel/SceneProfile/etc. byte pair before the ID word
						const word = u16();
						const odid = word >> 6;               // 10 bits ODID, 1 bit URL_Flag, 5 reserved
						const urlFlag = (word >> 5) & 1;
						const rec = {};
						if (urlFlag) {                          // points at an external resource, not an in-file ES
							const urlLen = u8();
							let url = "";
							for (let i = 0; i < urlLen && pos < s2; i++) url += String.fromCharCode(u8());
							rec.url = url;
						} else {
							while (pos < s2) {
								const t3 = u8(), l3 = readLen(), s3 = pos + l3;
								if (t3 === 0x0F) rec.esIdRef = u16();       // ES_ID_Ref -> mpod index (1-based)
								else if (t3 === 0x0E) rec.trackId = u32();  // ES_ID_Inc -> track ID
								else if (t3 === 0x03) {                     // inline ES_Descriptor -> grab its ES_ID
									rec.esId = u16();
								}
								pos = s3;
							}
						}
						map.set(odid, rec);
					}
					pos = s2;
				}
			}
			pos = stop;
		}
	} catch { /* fail-soft: return what we have */ }
	return map;
}
