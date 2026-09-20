import { ContractError, sha256 } from "./contracts";

// ---------------------------------------------------------------------------
// Protocol template compatibility.
//
// A run materializes the three protocol documents byte-identically from their
// bundled templates, and both `init` reconcile and the ORCH spawn re-verify those
// bytes. That pin is deliberate — a run's protocol must not drift under it — but
// it also means every template edit would make every previously created run fail
// `run_init_conflict`, and (worse) make it unrevivable, because the spawn path
// re-checks `protocol-orch.md`. A run created before an edit would become
// unrecoverable the moment its ORCH died: strictly worse than the documentation
// drift an edit fixes.
//
// So the pin accepts any digest this project has ever shipped for that document,
// and nothing else. A historical digest is accepted with a loud, named warning
// rather than silently: the run keeps working, and the operator is told its
// protocol text is older than the installed one.
//
// The sets include the installed template's own digest, so the command below
// reproduces this file exactly. Regenerate with, for each name:
//   for c in $(git log --format=%H -- skills/herdr-create/templates/<name>); do
//     git show "$c:skills/herdr-create/templates/<name>" | sha256sum; done | sort -u
// (before 3.11.0 the templates lived under skills/herdr-delegation/templates/;
// follow the rename with `git log --follow` when regenerating a full history.)
// Append — never replace — when a template changes, or runs created on the
// version you dropped stop loading.
// ---------------------------------------------------------------------------

const HISTORICAL_TEMPLATE_SHA256: Record<string, readonly string[]> = {
  "protocol.md": [
    "03f41b8b2d06386542288d5d34d2cae74bcdbd6a3a5e54cfec31edb21d2a0007",
    "12bd5e79a351343bf640dffa2bf1f611755b65093f515f83e21242de510404fa",
    "302100b99b63b1c2538ff094c7234373a2d58bb2f66d655619e056e18edf07a6",
    "541e6e67513b57ed30169dacc80f01cdeddbd6256603ab3f9c496e1b4d585e49",
    "892159ab6c7cce8eef6cd67982a7755dd2b89f8b65984f832fe58a3ebce69800",
    "928983a4525fc1af5c7c63e2b838e9b3a2ba9f27c4f38f5215302871ea06b410",
    "a3a4dbc91e3d7d991054527a7aeb68b08264a5728c3c0a461f0383c88963d2b0",
    "afaef27d683fbddb6e4efbcbcb9d966911de1c3bbda465a071cf83a2798565a0",
    "c407010d0580691fa005b22ed21631ddb2cf02b5c57126ee6c3db7c39c26d816",
  ],
  "protocol-orch.md": [
    "063136989cd60980849d7fc984a6dbf6dc3a23ff715d9981be26b8f5ddc30e7f",
    "1b8deddb0fd43d6ccc40a0864f9991a6b133bc87e468c24cb354d06a3f4ce2c8",
    "211dd1f432b50e5c1841d6073266cda66faeb223af7fa668e121a25bf4346459",
    "215c6d9298498edd08f0f094dd03710bec1cf9d85fc800ed29e67bcc3503cb9c",
    "239ee320be3a27befbedc80d736c7cc62561e0b76884d1dbaf5ce2b89e3f6fd6",
    "270ab6d10464e05b44e99aaab834ad692feafda46e15a86fba370d101a6a4302",
    "2c74b9f91bf1b0cef60841d3847d1cae7cdd2560b3d383e361344587f708c2df",
    "3a38ad75adcfd8cf53159a420a7ec2bd1207181f5d9a6ca0547fb20071e8d845",
    "4bedf7e0a305d582c7d67345c889786015bab138dc65b1e418dbf346005f78e1",
    "5dcc17e07e610e0f1e0c60ee331b08b45de110b653316658b495ca47f35f0bab",
    "953806b37230469867020924afa908a3ed5f30c26edc3e32960264b88ec89c74",
    "9e8f200214bec2133866e309a0053cbf73dce82539d4c8f17697c1fefd55610f",
    "a07b6449a6e335303645b813e494f8aa0c06d6093050e147c042954081941747",
    "a7a93e7ade3e80f0c1775663fea64c07c3b055ebc7f25758ecb2261ba4e2cc6b",
    "ac3004f8d155b326224a66dfc018072ee450a3a3f359ff6b90eeb42a35bf06d8",
    "d463fcc4789392191eadfb8b060a3f893f25c966ccb58f0df04c452f8a1afcae",
    "d6ab3311f9e00ebd998c90830921d245802713135f4cde785b7f126301c1b2b3",
    "df9d6dffe8247bccc9835fe7568cc804014bd477307a45bc401bec9ebd4a7243",
    "ebaf0b73d9bea260d0cf1bd889161ea8d3562b6d4b0f6042cf56d5a4524a77a2",
    "ec5abf2dbed74ab294db61332ed31b92c879493cc291c6d346eb673a3e30f79b",
  ],
  "protocol-worker.md": [
    "0207d67b390abc449c2424bed0e51df398406fa3b8a4c708dbf01b6496d8679e",
    "028ca798cdde7830a0d7374e4240370ae93690d0b9bfbae1bf2a46f6f1432c82",
    "0cfef803d9d8d39eb426fbc275f22bd18644e790cee7b610746d2fc64f1e466e",
    "2c855e47d2ab24c9a4932a94c61919518c93a6ee5f3ac40581d73d55675cf70b",
    "6da86841e66d7c9cf6cc00e4afa519002b5924806df417f4fff4a6fcfd694ee5",
    "8d7be06c72c1a0d0524f32a5d318fc47bf25c3a1070ce3f7bab56ff45cf10ce9",
    "aee1f733ca483e7eccbb928ba3c2759dbec1b689742f32853caa44e781dfd8e4",
    "b5c7715f2127a59ab93cd4c9aefda3f139f550add55f3cad95179e3b62bf4e91",
    "ca753da3d8cf88f8b82141a3e39e81f34d2fb7130b582a2c200f340dee145a5f",
    "cbac8e71bfe47fc0e9f79675ffb34a2afe6cfc28cf3c9dc85fb1ba1a0544f011",
    "cc887b4ec3a45e05aec752c7fdd39dd45cad488c9cf1673773ceeb7df8ae8d10",
    "d17d529ad67abb3050b653287da5963db844f728785ed335f6e7315df07b8aa0",
    "ddbd8536ae5e7cea0f5adbc9a91fbaf4b20aa70edd76a39c3f7eebc89811bb57",
    "eb284ba3ffa6a4777f2b47d0f83d3be5e602c3c1170e453374a58b2ed58f3f05",
  ],
};

export type TemplateAcceptance = { current: boolean; warning?: string };

/**
 * Accepts a run's existing protocol document against the installed template.
 * Byte-identical is silent; a previously shipped digest is accepted and named;
 * anything else fails closed exactly as before, now quoting the digest so the
 * mismatch is attributable rather than mysterious.
 */
export function acceptProtocolDocument(name: string, existing: Buffer, template: Buffer): TemplateAcceptance {
  if (existing.equals(template)) return { current: true };
  const digest = sha256(existing);
  const historical = HISTORICAL_TEMPLATE_SHA256[name] ?? [];
  if (!historical.includes(digest)) {
    throw new ContractError(
      "run_init_conflict",
      `Existing ${name} (sha256 ${digest}) is neither the installed template nor any version this project has shipped.`,
      "storage",
      {
        recovery: `Preserve the run and inspect ${name}: a protocol document is never edited in place. Copy the run's evidence into a fresh run instead of rewriting its protocol.`,
      },
    );
  }
  return {
    current: false,
    warning: `${name} in this run is an older shipped version (sha256 ${digest}); the installed template differs. The run keeps working on the text it was created with — read that file, not the current template, and create a fresh run if you need the newer protocol.`,
  };
}

// ---------------------------------------------------------------------------
// Backing contracts and the delivery they select.
//
// Three eras coexist, and a run's own accepted bytes — never its age, a config
// flag, an installed version or a digest list — decide which one it gets:
//
//   1. An unmarked protocol document: the original protocol-plus-guidance
//      pointers, exactly as that run was created.
//   2. A document whose frontmatter `name` is one of ROLE_SKILL_TEMPLATE_NAMES:
//      the generated run-local role skill era, still rendered from that run's
//      own body.
//   3. A document whose frontmatter carries PACKAGED_DELIVERY_MARKER: the
//      installed packaged role skills. Nothing is generated into the run.
//
// The markers are disjoint by construction: a packaged record declares no
// `name`, so `roleSkillBody` cannot claim it, and a generated-era body carries
// no `delivery` key, so `packagedDelivery` cannot claim that.
// ---------------------------------------------------------------------------

export const ROLE_SKILL_TEMPLATE_NAMES: Record<string, string> = {
  "protocol-orch.md": "herdr-orchestrator",
  "protocol-worker.md": "herdr-worker",
};

/** The frontmatter value that selects installed packaged role-skill delivery. */
export const PACKAGED_DELIVERY_MARKER = "herdr-packaged-role-skills/1";

/** The documents whose bytes may select packaged delivery, and the role each speaks for. */
export const PACKAGED_DELIVERY_ROLES: Record<string, "orchestrator" | "worker"> = {
  "protocol-orch.md": "orchestrator",
  "protocol-worker.md": "worker",
};

function frontmatter(document: Buffer | string): string | undefined {
  const text = typeof document === "string" ? document : document.toString("utf8");
  return /^---\n([\s\S]*?)\n---\n/.exec(text)?.[1];
}

/**
 * Whether this backing document selects installed packaged role skills. A
 * historical document — unmarked, or marked for the generated era — is false,
 * and an unreadable or absent document is the caller's own failure to report.
 */
export function packagedDelivery(name: string, document: Buffer | string): boolean {
  const role = PACKAGED_DELIVERY_ROLES[name];
  if (!role) return false;
  const front = frontmatter(document);
  if (!front) return false;
  const declared = /^delivery:[ \t]*(\S+)[ \t]*$/m.exec(front)?.[1];
  const declaredRole = /^role:[ \t]*(\S+)[ \t]*$/m.exec(front)?.[1];
  return declared === PACKAGED_DELIVERY_MARKER && declaredRole === role;
}

/**
 * The role-skill body of a protocol document, or `undefined` when the document
 * is not a marked role template. Frontmatter is preserved in the body: the
 * generated artifact is the skill, and its `name` is what the reader sees.
 */
export function roleSkillBody(name: string, document: Buffer | string): string | undefined {
  const expected = ROLE_SKILL_TEMPLATE_NAMES[name];
  if (!expected) return undefined;
  const text = typeof document === "string" ? document : document.toString("utf8");
  const front = frontmatter(text);
  if (!front) return undefined;
  const declared = /^name:[ \t]*(\S+)[ \t]*$/m.exec(front)?.[1];
  return declared === expected ? text : undefined;
}
