const stylesheetExtensions = [".css", ".scss", ".sass"];

function isStylesheet(urlOrSpecifier) {
  return stylesheetExtensions.some((extension) =>
    urlOrSpecifier.endsWith(extension),
  );
}

export async function resolve(specifier, context, nextResolve) {
  if (isStylesheet(specifier)) {
    const url = specifier.startsWith("file:")
      ? specifier
      : new URL(specifier, context.parentURL).href;
    return { url, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}

export async function load(url, context, nextLoad) {
  if (isStylesheet(url)) {
    return {
      format: "module",
      source: "export default {};",
      shortCircuit: true,
    };
  }
  return nextLoad(url, context);
}
