const copyButtons = document.querySelectorAll("[data-copy]");

for (const button of copyButtons) {
  button.addEventListener("click", async () => {
    const label = button.querySelector("span");

    try {
      await navigator.clipboard.writeText(button.dataset.copy);
      button.classList.add("copied");
      label.textContent = "Copied";
      window.setTimeout(() => {
        button.classList.remove("copied");
        label.textContent = "Copy";
      }, 1800);
    } catch {
      label.textContent = "Select";
    }
  });
}

const filters = document.querySelectorAll("[data-filter]");
const cards = document.querySelectorAll("[data-category]");

for (const filter of filters) {
  filter.addEventListener("click", () => {
    for (const candidate of filters) {
      candidate.classList.toggle("active", candidate === filter);
    }

    const selected = filter.dataset.filter;
    for (const card of cards) {
      card.classList.toggle(
        "hidden",
        selected !== "all" && card.dataset.category !== selected,
      );
    }
  });
}
