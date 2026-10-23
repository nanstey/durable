import type { ApprovalNonces } from "../approval/nonce.ts";

export type ApprovalBinding = {
	item: string;
	sha: string;
	pr?: number;
	action: "approve" | "approve-spec" | "resume" | "verify-policy";
};

/**
 * Approval credentials are deliberately a thin facade over the common nonce
 * store so every privileged action has identical action/item/binding rules.
 */
export function issueNonce(nonces: ApprovalNonces, binding: ApprovalBinding) {
	return nonces.issue(
		binding.action,
		binding.item,
		binding.pr === undefined ? binding.sha : `${binding.pr}:${binding.sha}`,
	);
}

export function verifyNonce(
	nonces: ApprovalNonces,
	binding: ApprovalBinding,
	code: string,
) {
	return nonces.verify(
		binding.action,
		binding.item,
		binding.pr === undefined ? binding.sha : `${binding.pr}:${binding.sha}`,
		code,
	);
}
