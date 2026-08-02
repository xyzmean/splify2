import { clsx, type ClassValue } from "clsx"
// Local 1KB stand-in for the 27KB `tailwind-merge` (uhttpd serves this bundle
// uncompressed). Kept honest by scripts/cn-equivalence.mjs, which asserts the
// two agree on every class combination this app can build and runs as the first
// step of `npm run build`. See src/lib/tw-merge.js.
import { twMerge } from "./tw-merge.js"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}
