const [major, minor] = process.versions.node.split('.').map(Number);

if (major !== 24 || minor < 21) {
  console.error(
    `SQLExplorer requires Node.js 24.21.x LTS; current runtime is ${process.version}.`,
  );
  console.error('On Windows run .\\scripts\\dev.ps1 to use the verified local toolchain.');
  process.exit(1);
}
