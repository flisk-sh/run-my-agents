// The one thing the site answers: how to install Run My Agents in a given client. The home page, /api/install and
// the MCP tool all call installSteps(), so they never disagree.

export const CLIENTS = ["claude-code"] as const;
export type Client = (typeof CLIENTS)[number];

export const INSTALL_COMMANDS = [
	"/plugin marketplace add flisk-sh/run-my-agents",
	"/plugin install run-my-agents@run-my-agents",
] as const;

export interface Install {
	client: Client;
	commands: readonly string[];
	needs: string;
	then: string;
}

/** Steps for a client, or undefined when the client is not supported yet. */
export function installSteps(client = "claude-code"): Install | undefined {
	if (client.trim().toLowerCase() !== "claude-code") return undefined;
	return {
		client: "claude-code",
		commands: INSTALL_COMMANDS,
		needs: "Claude Code and node on your PATH.",
		// biome-ignore lint/suspicious/noThenProperty: a JSON field of /api/install, which is only serialised, never awaited or imported
		then: "Open two or more Claude Code sessions on the same repo, or on worktrees of it, and work as usual. Before a session edits a file another session edited in the last 10 minutes, it gets a warning once.",
	};
}

/** The steps as plain text, for the MCP tool and llms.txt. */
export function summarize(i: Install): string {
	return `In Claude Code, run:\n${i.commands.join("\n")}\n\nNeeds: ${i.needs}\n${i.then}`;
}
