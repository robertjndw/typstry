// next-themes only applies the theme class after React mounts. Setting it
// here first avoids a white flash for dark-mode users. The storage key and
// values must match the ThemeProvider defaults in src/main.tsx.
try {
  const stored = localStorage.getItem("theme");
  const dark =
    stored === "dark" ||
    (stored !== "light" && matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.classList.add(dark ? "dark" : "light");
} catch {
  // Blocked storage: React applies the system theme on mount.
}
