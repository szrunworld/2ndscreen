#!/usr/bin/env node
// Manage who may use 2ndscreen-llm, through wrangler's KV commands on the deployed Worker.
//
//   npm run token -- create alice        print a new token for alice (shown once)
//   npm run token -- revoke alice        revoke every token of alice
//   npm run token -- list                list users and when their tokens were made
//   npm run token -- off | on            switch the Worker off or on for everyone
//
// Add --local to act on `wrangler dev`'s local KV instead. KV holds only each token's
// SHA-256, so a token printed here cannot be shown again; make a new one if it is lost.
// Changes reach every Cloudflare location within about a minute (KV's cache).

import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";

const args = process.argv.slice(2);
const where = args.includes("--local") ? "--local" : "--remote";
const [command, user] = args.filter((arg) => !arg.startsWith("--"));

function wrangler(...words) {
	return execFileSync("npx", ["wrangler", "kv", ...words, "--binding", "STATE", where], {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "inherit"],
	});
}

function tokenKeys() {
	const keys = JSON.parse(wrangler("key", "list", "--prefix", "token:"));
	return keys.map((key) => ({ name: key.name, ...(key.metadata ?? {}) }));
}

function requireUser() {
	if (!user || !/^[\w.@-]{1,64}$/.test(user)) {
		console.error("give a user name: letters, digits, . _ @ -, at most 64");
		process.exit(2);
	}
}

switch (command) {
	case "create": {
		requireUser();
		const token = `2s_${randomBytes(32).toString("base64url")}`;
		const hash = createHash("sha256").update(token).digest("hex");
		const created = new Date().toISOString();
		wrangler("key", "put", `token:${hash}`, JSON.stringify({ user, created }), "--metadata", JSON.stringify({ user, created }));
		console.log(`Token for ${user} (shown once; give it to them privately):\n\n  ${token}\n`);
		console.log("In 2ndscreen: AGENT_MODEL_API_KEY=<token>, AGENT_MODEL_BASE_URL=https://<worker>/v1");
		break;
	}
	case "revoke": {
		requireUser();
		const theirs = tokenKeys().filter((key) => key.user === user);
		if (theirs.length === 0) {
			console.error(`${user} has no tokens`);
			process.exit(1);
		}
		for (const key of theirs) {
			// Kept, marked revoked, so the list still shows who had access and when.
			const revoked = new Date().toISOString();
			wrangler("key", "put", key.name, JSON.stringify({ user, created: key.created, revoked: true }),
				"--metadata", JSON.stringify({ user, created: key.created, revoked }));
		}
		console.log(`Revoked ${theirs.length} token(s) of ${user}.`);
		break;
	}
	case "list": {
		const keys = tokenKeys();
		if (keys.length === 0) console.log("No tokens.");
		for (const key of keys) {
			console.log(`${key.user ?? "?"}\tcreated ${key.created ?? "?"}${key.revoked ? `\trevoked ${key.revoked}` : ""}`);
		}
		break;
	}
	case "off":
	case "on": {
		if (command === "off") wrangler("key", "put", "switch", "off");
		else wrangler("key", "delete", "switch");
		console.log(`2ndscreen-llm is ${command === "off" ? "switched off for everyone" : "on"}.`);
		break;
	}
	default:
		console.error("usage: npm run token -- create <user> | revoke <user> | list | off | on  [--local]");
		process.exit(2);
}
