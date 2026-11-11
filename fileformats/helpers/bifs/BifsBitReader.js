// MSB-first bit reader for MPEG-4 BIFS (ISO/IEC 14496-11) bitstreams.
//
// Ported from Sigurd Lerstad's own decoder, FirstProject2 IO::BitStream
// (include/LFC/BitStream.h getbit()/getnbits()): bits are consumed most-
// significant-bit-first within each byte, accumulating big-endian across byte
// boundaries. This is the bit order every BIFS field uses (config, command
// frames, node/field coding), so the whole decoder reads through this one class.
//
// `getnbits` accumulates with multiplication rather than `<<` so values wider
// than 31 bits stay correct (JS bitwise ops are 32-bit signed). It returns an
// UNSIGNED magnitude; callers that need a signed int32 (e.g. ReadSFInt32's raw
// 32-bit path) must reinterpret -- that's an M1 concern, not used by the config.
export class BifsBitReader
{
	/** @param {Uint8Array} bytes */
	constructor(bytes)
	{
		this.bytes = bytes;
		this.pos = 0;                  // the next bit to read, counted from the start
		this.end = bytes.length * 8;
	}

	// One bit position, read straight from the byte array: 2x the per-byte loop it
	// replaced over the conformance corpus (#1875), same values.
	//
	// Reading past the end of the access unit means the bitstream desynced (a wrong
	// field table, an unsupported coding path, etc.). Throw rather than return zero
	// bits -- fail-soft zeros would spin the `while(!getbit())` field/route loops
	// forever. Matches FirstProject2 getbyte (throws at EOF).

	/** Read `n` bits (0..32) MSB-first as an unsigned value. */
	getnbits(n)
	{
		const pos = this.pos;
		if (pos + n > this.end)
			throw new Error("BIFS: read past end of access unit (bitstream desync)");
		this.pos = pos + n;
		const bytes = this.bytes;
		let i = pos >>> 3;
		const have = 8 - (pos & 7);    // unread bits in the first byte
		let value = bytes[i] & (0xFF >>> (pos & 7));
		if (n <= have) return value >>> (have - n);
		let left = n - have;
		while (left >= 8) { value = value * 256 + bytes[++i]; left -= 8; }
		if (left > 0) value = value * (1 << left) + (bytes[++i] >>> (8 - left));
		return value;
	}

	/** Read a single bit as 0 or 1. */
	getbit()
	{
		const pos = this.pos;
		if (pos >= this.end)
			throw new Error("BIFS: read past end of access unit (bitstream desync)");
		this.pos = pos + 1;
		return (this.bytes[pos >>> 3] >>> (7 - (pos & 7))) & 1;
	}

	/** Total bits consumed so far -- compare against AU size to detect desync. */
	bitsConsumed()
	{
		return this.pos;
	}
}
