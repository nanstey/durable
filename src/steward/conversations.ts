export const startableConversationKinds = ["chat", "scout"] as const;
export type StartableConversationKind =
	(typeof startableConversationKinds)[number];

export function isStartableConversationKind(
	value: string,
	configured: readonly string[] | undefined,
): value is StartableConversationKind {
	const allowed = configured ?? startableConversationKinds;
	return (
		(startableConversationKinds as readonly string[]).includes(value) &&
		allowed.includes(value)
	);
}
