// expect: none
export async function load() {
  const mod = await import("tiny-http");
  return mod.get("/lazy");
}
