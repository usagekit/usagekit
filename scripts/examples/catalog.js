(() => {
  const { items, styles } = JSON.parse(document.getElementById("catalog-data").textContent);
  const find = (id) => document.getElementById(id);
  const frame = find("component-preview");
  const stateKeys = ["within", "near", "over", "partial", "unknown"];
  let selected,
    style,
    state,
    dark,
    files = [],
    sourceRequest = 0;
  let codeVisible = false;

  function readAddress() {
    const params = new URLSearchParams(location.search);
    selected =
      items.find((item) => item.name === params.get("block")) ??
      items.find((item) => item.name === "usage-overview-card") ??
      items[0];
    style = styles.find((item) => item.name === params.get("style")) ?? styles[0];
    state = stateKeys.includes(params.get("state")) ? params.get("state") : "within";
    dark = params.get("theme") === "dark";
  }
  function registryPath() {
    return `/r/styles/${style.name}/${selected.name}.json`;
  }
  function address() {
    const params = new URLSearchParams({ block: selected.name, style: style.name });
    if (state !== "within") params.set("state", state);
    if (dark) params.set("theme", "dark");
    return `${location.pathname}?${params}`;
  }
  function render(push = false) {
    sourceRequest++;
    if (push) history.pushState(null, "", address());
    document.documentElement.classList.toggle("dark", dark);
    document.title = `${selected.title} — Usagekit examples`;
    find("component-title").textContent = selected.title;
    find("component-description").textContent = selected.description;
    find("style-label").textContent = style.label;
    find("theme-toggle").setAttribute("aria-pressed", String(dark));
    find("theme-toggle").setAttribute("aria-label", `Switch to ${dark ? "light" : "dark"} theme`);
    find("copy-status").textContent = "";
    for (const link of document.querySelectorAll("[data-block]")) {
      if (link.dataset.block === selected.name) link.setAttribute("aria-current", "page");
      else link.removeAttribute("aria-current");
      const params = new URLSearchParams({ block: link.dataset.block, style: style.name });
      if (dark) params.set("theme", "dark");
      link.href = `?${params}`;
    }
    for (const button of document.querySelectorAll("[data-library]"))
      button.setAttribute("aria-pressed", String(button.dataset.library === style.variant));
    for (const button of document.querySelectorAll("[data-style]")) {
      button.hidden = button.dataset.variant !== style.variant;
      button.setAttribute("aria-pressed", String(button.dataset.style === style.name));
    }
    for (const button of document.querySelectorAll("[data-state]"))
      button.setAttribute("aria-pressed", String(button.dataset.state === state));
    find("state-controls").hidden =
      !["usage-overview-card", "usage-cap-pill"].includes(selected.name) || codeVisible;
    const params = new URLSearchParams({
      embed: selected.name,
      style: style.name,
      state,
      theme: dark ? "dark" : "light",
    });
    frame.title = `${selected.title} live preview`;
    frame.height = "540";
    frame.src = `/examples/showcase/?${params}`;
    params.delete("embed");
    find("open-example").href = `/examples/showcase/?${params}`;
    find("registry-link").href = registryPath();
    find("install-command").textContent =
      "npx shadcn add " + new URL(registryPath(), location.origin).href;
    files = [];
    if (codeVisible) loadSource();
  }
  function chooseTab(code) {
    codeVisible = code;
    for (const [id, active] of [
      ["code-tab", code],
      ["preview-tab", !code],
    ]) {
      find(id).setAttribute("aria-selected", String(active));
      find(id).tabIndex = active ? 0 : -1;
    }
    find("code-panel").hidden = !code;
    find("preview-panel").hidden = code;
    find("state-controls").hidden =
      code || !["usage-overview-card", "usage-cap-pill"].includes(selected.name);
    if (code && !files.length) loadSource();
  }
  function showFile(index) {
    find("source-code").textContent = files[index].content;
    for (const [i, button] of [...find("source-files").children].entries())
      button.setAttribute("aria-pressed", String(i === index));
  }
  async function loadSource() {
    const request = ++sourceRequest;
    find("source-files").replaceChildren();
    find("source-code").textContent = "Loading component source…";
    find("copy-source").disabled = true;
    try {
      const response = await fetch(registryPath());
      if (!response.ok) throw Error("Registry unavailable");
      const data = await response.json();
      if (request !== sourceRequest) return;
      files = data.files.filter((file) => typeof file.content === "string");
      if (!files.length) throw Error("No source files");
      for (const [index, file] of files.entries()) {
        const button = document.createElement("button");
        button.type = "button";
        button.textContent = file.path.split("/").at(-1);
        button.addEventListener("click", () => showFile(index));
        find("source-files").append(button);
      }
      showFile(0);
      find("copy-source").disabled = false;
    } catch {
      if (request === sourceRequest)
        find("source-code").textContent =
          "Source could not be loaded. Open Registry JSON or try another component.";
    }
  }
  async function copy(text) {
    try {
      await navigator.clipboard.writeText(text);
      find("copy-status").textContent = "Copied to clipboard.";
    } catch {
      find("copy-status").textContent =
        "Clipboard unavailable. Select and copy the text shown above.";
    }
  }
  find("copy-install").addEventListener("click", () => copy(find("install-command").textContent));
  find("copy-source").addEventListener("click", () => copy(find("source-code").textContent));
  find("theme-toggle").addEventListener("click", () => {
    dark = !dark;
    render(true);
  });
  for (const link of document.querySelectorAll("[data-block]"))
    link.addEventListener("click", (event) => {
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      event.preventDefault();
      selected = items.find((item) => item.name === link.dataset.block);
      render(true);
    });
  for (const button of document.querySelectorAll("[data-library]"))
    button.addEventListener("click", () => {
      style =
        styles.find(
          (item) => item.variant === button.dataset.library && item.sheet === style.sheet,
        ) ??
        styles.find((item) => item.variant === button.dataset.library && item.sheet === "vega");
      render(true);
    });
  for (const button of document.querySelectorAll("[data-style]"))
    button.addEventListener("click", () => {
      style = styles.find((item) => item.name === button.dataset.style);
      find("style-menu").open = false;
      render(true);
      find("style-menu").querySelector("summary").focus();
    });
  for (const button of document.querySelectorAll("[data-state]"))
    button.addEventListener("click", () => {
      state = button.dataset.state;
      render(true);
    });
  find("style-menu").addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      find("style-menu").open = false;
      find("style-menu").querySelector("summary").focus();
    }
  });
  document.addEventListener("click", (event) => {
    if (!find("style-menu").contains(event.target)) find("style-menu").open = false;
  });
  find("component-search").addEventListener("input", (event) => {
    const value = event.target.value.trim().toLowerCase();
    let visible = 0;
    for (const link of document.querySelectorAll("[data-block]")) {
      link.hidden = !link.dataset.search.includes(value);
      if (!link.hidden) visible++;
    }
    for (const group of document.querySelectorAll(".nav-group"))
      group.hidden = ![...group.querySelectorAll("a")].some((link) => !link.hidden);
    find("search-empty").hidden = visible !== 0;
  });
  for (const id of ["preview-tab", "code-tab"]) {
    find(id).addEventListener("click", () => chooseTab(id === "code-tab"));
    find(id).addEventListener("keydown", (event) => {
      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
      event.preventDefault();
      const code = event.key === "Home" ? false : event.key === "End" ? true : !codeVisible;
      chooseTab(code);
      find(code ? "code-tab" : "preview-tab").focus();
    });
  }
  window.addEventListener("message", (event) => {
    if (
      event.origin !== location.origin ||
      event.source !== frame.contentWindow ||
      event.data?.type !== "usagekit-example-size" ||
      event.data.block !== selected.name
    )
      return;
    const height = event.data.height;
    if (Number.isFinite(height) && height > 0)
      frame.height = String(Math.min(1000, Math.max(220, Math.ceil(height))));
  });
  window.addEventListener("popstate", () => {
    readAddress();
    render();
  });
  readAddress();
  render();
})();
