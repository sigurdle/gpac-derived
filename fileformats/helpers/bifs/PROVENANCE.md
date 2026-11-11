# Provenance -- MPEG-4 BIFS decoder and Text layout (GPAC-derived parts)

These files are JavaScript. Parts of them were written by following GPAC's C source, so those parts
are a derived work of GPAC and are published here under GPAC's license.

**Upstream:** GPAC, https://github.com/gpac/gpac, read from `master` on 2026-11-10 and 2026-11-11
(its latest commit then: `f7877e3617b6d892b4737a109c3a851b3d6bb706`, 2026-11-08).
**Copyright:** Telecom ParisTech 2000-2026, author Jean Le Feuvre (see the header of each GPAC file).
**License:** GNU Lesser General Public License, version 2.1 or (at your option) any later version.
The full text is `COPYING.LGPLv2.1`.

## Two sources

The decoder started as a port of Sigurd Lerstad's own C++ decoder ([FirstProject2](https://github.com/sigurdle/FirstProject2): `BIFSDecoder.cpp`,
`BIFSDec.cpp`, `ODDecoder.cpp`, `IO::BitStream`), and was then extended by following GPAC. Each
file's header says which parts come from where.

| file | from Sigurd's FirstProject2 | follows GPAC |
|---|---|---|
| `fileformats/helpers/bifs/BifsBitReader.js` | all of it (`IO::BitStream`) | nothing |
| `fileformats/helpers/bifs/BifsGeometry.js` | all of it (`X3DNode.cpp` draw_curve) | nothing |
| `fileformats/helpers/bifs/ODDecoder.js` | all of it (`ODDecoder.cpp`) | nothing |
| `fileformats/helpers/bifs/BifsConfig.js` | the config reader | two details (`gf_bifs_decoder_configure_stream`, `bifs_codec.c` ParseConfig) |
| `fileformats/helpers/bifs/BifsDecoder.js` | the command loop, SceneReplacement, the node and field coding | `src/bifs/field_decode.c` (QuantizationParameter scope), `unquantize.c`, `com_dec.c` (update commands, PROTOs, ROUTEs), `memory_decoder.c` |
| `fileformats/helpers/bifs/BifsScript.js` | nothing | `src/bifs/script_dec.c`, `script.h` |
| `fileformats/helpers/bifs/BifsTables.js` | nothing | generated from `src/scenegraph/mpeg4_nodes.c` and `include/gpac/internal/bifs_tables.h` |
| `tools/gen-bifs-tables.mjs` | ours: the generator of `BifsTables.js` | reads the two GPAC files above |
| `players/x3d/nodes/TextNodes.js` | nothing | the layout: `src/compositor/mpeg4_text.c` (build_text), `font_engine.c` |

The files that follow nothing of GPAC are published with the rest so the decoder is complete as it
runs.

## Departures from GPAC

* `BifsTables.js`: Switch's `choice` field is named `children`.
* `BifsDecoder.js`: a QuantizationParameter with `isLocal` scopes the one sibling after it in a
  vector-coded children list too (ISO/IEC 14496-11 9.3.7); GPAC does that for a list-coded one only.
* `TextNodes.js`: glyph boxes used for picking sit where the glyphs are drawn; the header lists what
  is not built.

## Rebuilding the tables

    node tools/gen-bifs-tables.mjs <dir holding mpeg4_nodes.c and bifs_tables.h> <out file>

## What is not here

`TextNodes.js` imports application code (the scene node base classes, the font registry, the path
builder) that is not derived from GPAC and is not published.
