export interface FontsPackagesTarget {
  tab: "fonts" | "packages";
  /** A package spec to pin or to ask for, e.g. from a compile error. */
  prefill?: string;
}
