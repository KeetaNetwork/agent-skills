const copyStatus = document.getElementById("copy-status");

function announce(message) {
  if (copyStatus) {
    copyStatus.textContent = "";
    window.setTimeout(() => {
      copyStatus.textContent = message;
    }, 50);
  }
}

function selectCommand(button) {
  const code = button.closest(".command")?.querySelector("code");
  if (!code) {
    return;
  }
  const range = document.createRange();
  range.selectNodeContents(code);
  const selection = window.getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
}

for (const button of document.querySelectorAll("[data-copy]")) {
  button.addEventListener("click", async () => {
    const label = button.querySelector("span");

    try {
      await navigator.clipboard.writeText(button.dataset.copy);
      button.classList.add("copied");
      label.textContent = "Copied";
      announce("Copied to clipboard");
      window.setTimeout(() => {
        button.classList.remove("copied");
        label.textContent = "Copy";
      }, 1800);
    } catch {
      selectCommand(button);
      announce("Copy is unavailable here. The command is selected, so press Ctrl+C or Cmd+C.");
    }
  });
}

const filters = document.querySelectorAll("[data-filter]");
const cards = document.querySelectorAll("[data-category]");

for (const filter of filters) {
  filter.addEventListener("click", () => {
    for (const candidate of filters) {
      candidate.setAttribute("aria-pressed", String(candidate === filter));
    }

    const selected = filter.dataset.filter;
    for (const card of cards) {
      card.classList.toggle("hidden", selected !== "all" && card.dataset.category !== selected);
    }
  });
}

const header = document.querySelector(".nav");
const menuToggle = document.querySelector(".menu-toggle");

function setMenu(open) {
  header.classList.toggle("is-open", open);
  menuToggle.setAttribute("aria-expanded", String(open));
  menuToggle.setAttribute("aria-label", open ? "Close menu" : "Open menu");
}

if (header && menuToggle) {
  menuToggle.addEventListener("click", () => {
    setMenu(!header.classList.contains("is-open"));
  });

  for (const link of header.querySelectorAll("nav a")) {
    link.addEventListener("click", () => setMenu(false));
  }

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && header.classList.contains("is-open")) {
      setMenu(false);
      menuToggle.focus();
    }
  });

  document.addEventListener("click", (event) => {
    if (header.classList.contains("is-open") && !header.contains(event.target)) {
      setMenu(false);
    }
  });

  window.matchMedia("(min-width: 768px)").addEventListener("change", (event) => {
    if (event.matches) {
      setMenu(false);
    }
  });
}
