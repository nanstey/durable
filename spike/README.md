# spike/ (throwaway)

Scripts from the slice 1 feasibility spike. Results are recorded in [docs/evidence/spike.md](../docs/evidence/spike.md).

- Not part of the product. Excluded from the npm package: `package.json` `files` lists only product dirs.
- Safe to delete once the evidence is no longer needed.
- Run each script in its own `mktemp -d` dir outside the checkout, with the 1.4.0 pins installed there.
- Use only **copies** of credentials; several scripts fabricate fake ones on purpose.
- None of these scripts contacts Anthropic. `anthropic-shaping-stub.ts` uses a loopback stub and a fabricated token.
