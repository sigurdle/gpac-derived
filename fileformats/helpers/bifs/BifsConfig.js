// BIFSConfig -- the DecoderSpecificInfo of an MPEG-4 Systems scene-description
// stream (streamType 0x03), carried as the esds tag-0x05 blob of the 'mp4s'
// sample entry. It sets the bit-widths the command/scene decoder needs
// (nodeIDbits/routeIDbits, and protoIDbits in v2) plus the scene's pixel size.
//
// Ported verbatim from Sigurd Lerstad's own decoder, FirstProject2
// MP4Track.cpp BIFSConfig::Read (v1) and BIFSv2Config::Read (v2). The version is
// chosen by the DecoderConfigDescriptor objectTypeIndication: 0x01 = MPEG-4
// Systems v1, 0x02 = v2 (MP4Track.cpp:537-548). A v2 stream parsed with the v1
// layout desyncs from the very first bit, so the fork is mandatory even though
// the 2D conformance corpus is all v1.

import { BifsBitReader } from "./BifsBitReader.js";

/**
 * @param {Uint8Array|null|undefined} descriptor  esds DecoderSpecificInfo bytes
 * @param {number} objectTypeIndication           DecoderConfigDescriptor OTI (0x01 v1 / 0x02 v2)
 * @returns {object|null} decoded config, or null if there's no descriptor
 */
export function parseBifsConfig(descriptor, objectTypeIndication)
{
	if (!descriptor || descriptor.length === 0) return null;

	// The layout the object type names; if that does not use up the descriptor exactly, the other one
	// (GPAC gf_bifs_decoder_configure_stream). Observed: OptiBase's BIFSWithProtosAndUSENAMES/test.mp4 has
	// object type 0xFF and a v2 config. When neither fits, the named layout stands.
	const v2 = objectTypeIndication === 0x02;
	const read = (asV2) => {
		try { return readBifsConfig(descriptor, asV2); }
		catch (e) { return { cfg: null, fits: false, error: e }; }
	};
	const named = read(v2);
	if (named.fits) return named.cfg;
	const other = read(!v2);
	if (other.fits) return other.cfg;
	if (!named.cfg) throw named.error;
	return named.cfg;
}

// One layout's reading: `fits` is false when a command stream's config does not end where the descriptor does.
function readBifsConfig(descriptor, v2)
{
	const br = new BifsBitReader(descriptor);

	const cfg = {
		version: v2 ? 2 : 1,
		use3DmeshCoding: false,
		usePredictiveMFField: false,   // v2 only
		nodeIDbits: 0,
		routeIDbits: 0,
		protoIDbits: 0,          // v2 only
		isCommandStream: false,
		pixelMetric: false,
		hasSize: false,
		pixelWidth: -1,
		pixelHeight: -1,
	};

	if (v2)
	{
		cfg.use3DmeshCoding = !!br.getbit();
		cfg.usePredictiveMFField = !!br.getbit();   // GPAC bifs_codec.c ParseConfig
		cfg.nodeIDbits = br.getnbits(5);
		cfg.routeIDbits = br.getnbits(5);
		cfg.protoIDbits = br.getnbits(5);
	}
	else
	{
		cfg.nodeIDbits = br.getnbits(5);
		cfg.routeIDbits = br.getnbits(5);
	}

	cfg.isCommandStream = !!br.getbit();
	if (cfg.isCommandStream)
	{
		// 1 metre == the distance between two pixels (applies to both axes).
		cfg.pixelMetric = !!br.getbit();
		cfg.hasSize = !!br.getbit();
		if (cfg.hasSize)
		{
			cfg.pixelWidth = br.getnbits(16);
			cfg.pixelHeight = br.getnbits(16);
		}
	}
	// else: BIFS-Anim configuration (randomAccess bit + AnimationMask) -- not yet
	// decoded; the conformance scenes here are all command streams.

	return { cfg, fits: !cfg.isCommandStream || Math.ceil(br.bitsConsumed() / 8) === descriptor.length };
}
