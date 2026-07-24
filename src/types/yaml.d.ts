// Wrangler bundles *.yaml imports as text via the [[rules]] Text rule in
// wrangler.toml. This declaration keeps `tsc --noEmit` in agreement.
declare module "*.yaml" {
  const text: string;
  export default text;
}
