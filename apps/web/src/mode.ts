// Set at build time for the static build (GitHub Pages): no server exists, so
// projects live only in this browser and every feature that needs a server
// is left out. A constant, so the bundler drops the branches it switches off.
export const LOCAL_ONLY = import.meta.env.VITE_TYPSTRY_LOCAL_ONLY === "1";
