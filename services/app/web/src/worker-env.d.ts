// Images the Worker bundles as binary modules (the Data rule in wrangler.toml).
declare module "*.gif" {
	const data: ArrayBuffer;
	export default data;
}
declare module "*.jpg" {
	const data: ArrayBuffer;
	export default data;
}
declare module "*.png" {
	const data: ArrayBuffer;
	export default data;
}
