const list = document.getElementById("products");
const price = new Intl.NumberFormat("en-GB", { style: "currency", currency: "GBP" });

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} answered ${res.status}`);
  return res.json();
}

/** Asks the web server where the API is, then fetches the products from it. */
async function loadProducts() {
  const { apiUrl } = await fetchJson("/config.json");
  return fetchJson(`${apiUrl}/products`);
}

// Text goes in with textContent, never innerHTML, so a product name can't inject markup.
function listItem(...cells) {
  const item = document.createElement("li");
  for (const text of cells) {
    const cell = document.createElement("span");
    cell.textContent = text;
    item.append(cell);
  }
  return item;
}

function showProducts(products) {
  list.replaceChildren(
    ...products.map((product) => listItem(product.name, price.format(product.pricePence / 100))),
  );
}

function showError(err) {
  const item = listItem(`Could not reach the API: ${err.message}`);
  item.className = "error";
  list.replaceChildren(item);
}

loadProducts().then(showProducts, showError);
