const DRAG_REGION_ATTRIBUTE = "data-tauri-drag-region";
const DRAG_REGION_SELECTOR = ".drag-region";

function syncNode(node: Element): void {
  if (node.matches(DRAG_REGION_SELECTOR)) {
    node.setAttribute(DRAG_REGION_ATTRIBUTE, "");
  } else if (node.hasAttribute(DRAG_REGION_ATTRIBUTE)) {
    node.removeAttribute(DRAG_REGION_ATTRIBUTE);
  }

  for (const child of node.querySelectorAll(DRAG_REGION_SELECTOR)) {
    child.setAttribute(DRAG_REGION_ATTRIBUTE, "");
  }
}

export function attachDragRegionAdapter(): () => void {
  for (const element of document.querySelectorAll(DRAG_REGION_SELECTOR)) {
    element.setAttribute(DRAG_REGION_ATTRIBUTE, "");
  }

  const observer = new MutationObserver((records) => {
    for (const record of records) {
      if (record.type === "attributes") {
        const target = record.target;
        if (target instanceof Element) {
          syncNode(target);
        }
        continue;
      }

      for (const node of record.addedNodes) {
        if (node instanceof Element) {
          syncNode(node);
        }
      }
    }
  });

  observer.observe(document.documentElement, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ["class"],
  });

  return () => {
    observer.disconnect();
  };
}
