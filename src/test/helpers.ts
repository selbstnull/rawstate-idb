export const until = async (check: () => boolean, ms = 2000) => {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > ms) throw new Error("until: timeout");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};
