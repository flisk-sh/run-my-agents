// The kitchen's own agent types, one per stage, matching the skill-set table on the Crew tab: Spec, Build, Test and
// Review. Container agents get one of these four, never the general types (Planner, Code, Bug ...) your own chats use,
// and they stay out of the type picker for your sessions.
import type { Agent } from "../../../web/src/avatars";
import type { Stage } from "./pipeline";

export const KITCHEN_AGENTS: Pick<Agent, "role" | "color" | "shape" | "eyes" | "extra">[] = [
	{ role: "Spec", color: "#a78bfa", shape: "tall", eyes: "wide" },
	{ role: "Build", color: "#38bdf8", shape: "circle", eyes: "visor" },
	{ role: "Test", color: "#f59e0b", shape: "pill", eyes: "squint", extra: "bug" },
	{ role: "Review", color: "#22c55e", shape: "square", eyes: "ovals" },
];
export const KITCHEN_ROLES = KITCHEN_AGENTS.map((a) => a.role);

export const WORK_STAGES = ["spec", "build", "test", "review"] as const;
export type WorkStage = (typeof WORK_STAGES)[number];
/** The kitchen type that staffs each stage. */
export const STAGE_TYPE: Record<WorkStage, string> = { spec: "Spec", build: "Build", test: "Test", review: "Review" };
export const isWorkStage = (s: Stage): s is WorkStage => (WORK_STAGES as readonly string[]).includes(s);
