// Types `exports` from "cloudflare:workers" (and ctx.exports) with this Worker's main module.
declare namespace Cloudflare {
	interface GlobalProps {
		mainModule: typeof import("./index");
	}
}
