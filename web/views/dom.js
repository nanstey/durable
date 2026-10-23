export function element(name, text, className) {
	const node = document.createElement(name);
	if (className) node.className = className;
	if (text !== undefined) node.textContent = String(text);
	return node;
}

export function textBlock(value) {
	return element("pre", value ?? "", "inert-text");
}

export function githubOpen(url) {
	const button = element("a", "Open GitHub", "button");
	button.href = url;
	button.target = "_blank";
	button.rel = "noopener noreferrer";
	return button;
}
