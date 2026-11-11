# Provenance -- MPEG-4 BIFS decoder and scene nodes (GPAC-derived parts)

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
| `players/x3d/nodes/AppearanceNodes.js` | nothing | the 2D look and picking: `src/compositor/drawable.c` (drawable_get_aspect_2d_mpeg4), `visual_manager_2d_draw.c` |
| `players/x3d/nodes/GeometryNodes.js` | nothing | `mpeg4_geometry_ifs2d.c`, `mpeg4_geometry_ils2d.c`, PointSet2D, picking (vrml_drawable_pick) |
| `players/x3d/nodes/GroupingNodes.js` | nothing | `mpeg4_layer_2d.c`, the sensor grouping rule |
| `players/x3d/nodes/MediaNodes.js` | nothing | `mpeg4_textures.c` (movie time, PixelTexture), `mpeg4_bitmap.c`, `mpeg4_audio.c`, `mpeg4_sound.c` |
| `players/x3d/nodes/RuntimeNodes.js` | nothing | `src/scenegraph/mpeg4_valuator.c`, the 2D sensors and Anchor, the interpolators |
| `players/x3d/nodes/SensorNodes.js` | nothing | TouchSensor (`mpeg4_sensors.c` OnTouchSensor) |
| `players/x3d/nodes/CommandNodes.js` | nothing | `src/bifs/conditional.c` |
| `players/x3d/nodes/Nodes3D.js` | nothing; its camera, light and normal rules are written from VRML97 | which scene is 3D (`compositor.c`), `mesh.c` GET_IDX, the projection and matrix helpers |
| `players/x3d/nodes/InfoNodes.js`, `NodeTypes.js`, `X3DNode.js` | nothing | field defaults from `mpeg4_nodes.c` (InfoNodes); the other two follow nothing of GPAC |
| `players/x3d/X3DScene.js` | nothing | applying commands and routes (`src/bifs/com_dec.c` BD_Dec*, gf_node_replace), pointer events (`src/compositor/events.c`) |

Field defaults in the node files are those of GPAC's `src/scenegraph/mpeg4_nodes.c` (`*_Create`).

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

The node files import application code (the node base classes, the font registry, the path builder,
the drawing and sound classes) that is not published. Other player files match a GPAC behavior in a
few places and say so in a comment; they are not published either.
