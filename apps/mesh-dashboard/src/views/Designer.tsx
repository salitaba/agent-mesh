/* Barrel re-export so existing imports (`import Designer from "./views/Designer"`)
 * keep working. The real implementation lives in src/designer/. */

export { default } from "../designer/Designer";