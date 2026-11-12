// Files the board imports that carry no types: the hooks' plain .mjs and the preact bundle read as text.
declare module "*.mjs";
declare module "*.min.js" {
	const text: string;
	export default text;
}
