/*
** Conditional: a node that holds BIFS commands and runs them when told to (ISO/IEC 14496-11 Conditional).
**
** Read from GPAC's src/bifs/conditional.c: `activate` TRUE runs the buffer, `reverseActivate` FALSE runs it;
** each run first sets isActive TRUE and sends it (GPAC never sends FALSE). Defaults: mpeg4_nodes.c
** (Conditional_Create).
**
** `buffer` is the decoder's {commands, error}: the buffer's command frame already decoded into command
** records (fileformats/helpers/bifs/BifsDecoder.js resolveCommandBuffers; GPAC decodes the bytes on each
** run). The scene's one executor applies them (X3DScene.applyCommand), inside the cascade of the event
** that activated the node. A node a command carries is built anew on every run.
*/

import {X3DNode} from "./X3DNode.js";

export class Conditional extends X3DNode
{
	constructor()
	{
		super("Conditional");
		this.activate = false;
		this.reverseActivate = false;
		this.buffer = {commands: [], error: null};
		this.isActive = false;
	}

	receive(name, value, scene, time)
	{
		if (name === "activate") {
			this.activate = value;
			if (value === true) {
				this._run(scene, time);
			}
		} else if (name === "reverseActivate") {
			this.reverseActivate = value;
			if (value === false) {
				this._run(scene, time);
			}
		} else {
			super.receive(name, value, scene, time);
		}
	}

	_run(scene, time)
	{
		this.isActive = true;
		scene.emit(this, "isActive", true, time);
		// GPAC's Conditional_execute: the buffer is empty while it runs, so a buffer that activates its own node
		// (or two that activate each other) runs nothing the second time; it comes back afterwards unless one
		// of the commands gave the node a new buffer.
		const buffer = this.buffer;
		const running = {commands: [], error: null};
		this.buffer = running;
		try {
			for (const command of buffer.commands) {
				scene.applyCommand(command, time);
			}
		} finally {
			if (this.buffer === running) {
				this.buffer = buffer;
			}
		}
	}
}
