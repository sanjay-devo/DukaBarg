const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
const databaseRules = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "database.rules.json"), "utf8"));
const extract = (start, end) => {
  const startIndex = html.indexOf(start);
  const endIndex = html.indexOf(end, startIndex);
  assert.notEqual(startIndex, -1, `Missing source marker: ${start}`);
  assert.notEqual(endIndex, -1, `Missing source marker: ${end}`);
  return html.slice(startIndex, endIndex);
};

const categoryFunctions = extract(
  "      function valueAsId(",
  "      function isCategoryActive(",
);
const countFunctions = extract(
  "      function productCount(",
  "      function formatCategoryDate(",
);
const productFunctions = extract(
  "      function productCategory(",
  "      async function waitForCategories(",
);
const labelFunctions = extract(
  "      function productCategoryLabel(",
  "      function escapeProductHtml(",
);
const selectionFunctions = extract(
  "      function categoriesAt(",
  "      function setCategoryFilterOptions(",
);

const context = vm.createContext({
  categoryState: { categories: [], products: {}, categoryDiagnostics: [] },
  console: { warn() {} },
});
vm.runInContext(
  `${categoryFunctions}\n${countFunctions}\n${productFunctions}\n${labelFunctions}\n${selectionFunctions}`,
  context,
);

const fixture = {
  masterDairy: { name: "Dairy & Eggs", level: "master", status: "active" },
  masterDrinks: { name: "Beverages", level: "master", status: "active" },
  eggs: { name: "Egg", level: "category", parentId: "masterDairy", masterCategoryId: "masterDairy", status: "active" },
  milk: { name: "Milk", level: "category", parentId: "masterDairy", masterCategoryId: "masterDairy", status: "active" },
  juice: { name: "Juice", level: "category", parentId: "masterDrinks", masterCategoryId: "masterDrinks", status: "active" },
  brownEggs: { name: "Brown Eggs", level: "subcategory", parentId: "eggs", masterCategoryId: "masterDairy", status: "active" },
  whiteEggs: { name: "White Eggs", level: "subcategory", parentId: "eggs", masterCategoryId: "masterDairy", status: "active" },
  skimMilk: { name: "Skim", level: "subcategory", parentId: "milk", masterCategoryId: "masterDairy", status: "active" },
  juiceBox: { name: "Box", level: "subcategory", parentId: "juice", masterCategoryId: "masterDrinks", status: "active" },
};

function normalize(data = fixture) {
  context.categoryState.categoryDiagnostics = [];
  context.categoryState.categories = context.normalizeCategories(data);
  return context.categoryState.categories;
}

function entry(id) {
  return context.categoryState.categories.find((category) => category.id === id);
}

test("master, category, and subcategory resolve using Firebase keys and direct parents", () => {
  normalize();
  assert.deepEqual(
    [entry("masterDairy").level, entry("eggs").level, entry("brownEggs").level],
    ["master", "category", "subcategory"],
  );
  assert.equal(entry("eggs").parentId, "masterDairy");
  assert.equal(entry("brownEggs").parentId, "eggs");
  assert.equal(entry("brownEggs").valid, true);
});

test("legacy parent aliases resolve without rewriting the source record", () => {
  normalize({
    m: { name: "Root", type: "root" },
    c: { categoryName: "Child", parent_id: "m" },
    s: { title: "Leaf", category_id: "c" },
  });
  assert.deepEqual([entry("m").level, entry("c").level, entry("s").level], ["master", "category", "subcategory"]);
  assert.equal(entry("s").valid, true);
  assert.equal(entry("s").raw.category_id, "c");
});

test("a mismatched embedded ID is diagnosed while the Firebase key remains canonical", () => {
  normalize({ key: { id: "other", name: "Root", level: "master" } });
  assert.equal(entry("key").id, "key");
  assert.equal(entry("key").valid, true);
  assert.match(context.categoryState.categoryDiagnostics[0].reason, /differs from the Firebase key/);
});

test("malformed, orphaned, and circular category records are diagnosed", () => {
  normalize({
    root: { name: "Root", level: "master" },
    orphan: { name: "Orphan", level: "category", parentId: "missing" },
    first: { name: "First", level: "category", parentId: "second" },
    second: { name: "Second", level: "category", parentId: "first" },
  });
  assert.equal(entry("orphan").valid, false);
  assert.match(entry("orphan").error, /does not exist/);
  assert.match(entry("first").error, /Circular/);
  assert.ok(context.categoryState.categoryDiagnostics.length >= 3);
});

test("a product with all valid IDs resolves its complete canonical path", () => {
  normalize();
  const resolved = context.productCategoryPath({
    masterCategoryId: "masterDairy",
    categoryId: "eggs",
    subcategoryId: "brownEggs",
  });
  assert.deepEqual(
    [resolved.master.id, resolved.category.id, resolved.subcategory.id, resolved.error],
    ["masterDairy", "eggs", "brownEggs", ""],
  );
});

test("a missing subcategory preserves the saved master and category", () => {
  normalize();
  const resolved = context.productCategoryPath({ categoryId: "eggs" });
  assert.deepEqual([resolved.master.id, resolved.category.id, resolved.subcategory], ["masterDairy", "eggs", null]);
  const legacyNames = context.productCategoryPath({
    categoryName: "Egg",
    masterCategoryName: "Dairy & Eggs",
    categoryId: "eggs",
  });
  assert.deepEqual([legacyNames.master.id, legacyNames.category.id, legacyNames.error], ["masterDairy", "eggs", ""]);
});

test("a missing intermediate category is recovered from a valid subcategory parent", () => {
  normalize();
  const resolved = context.productCategoryPath({ subcategoryId: "brownEggs" });
  assert.deepEqual([resolved.master.id, resolved.category.id, resolved.subcategory.id], ["masterDairy", "eggs", "brownEggs"]);
});

test("duplicate names under different parents resolve only by ID", () => {
  normalize({
    masterA: { name: "A", level: "master" },
    masterB: { name: "B", level: "master" },
    categoryA: { name: "Produce", level: "category", parentId: "masterA" },
    categoryB: { name: "Produce", level: "category", parentId: "masterB" },
  });
  const resolved = context.productCategoryPath({ categoryId: "categoryB" });
  assert.equal(resolved.category.id, "categoryB");
  assert.equal(resolved.master.id, "masterB");
});

test("name-only product references warn rather than guessing", () => {
  normalize();
  const resolved = context.productCategoryPath({ categoryName: "Egg" });
  assert.match(resolved.error, /without a reliable ID/);
  assert.equal(context.productCategoryLabel({ categoryName: "Egg" }), "Category needs correction");
});

test("invalid, wrong-level, and cross-master product references are rejected", () => {
  normalize();
  assert.match(context.productCategoryPath({ categoryId: "missing" }).error, /missing, invalid/);
  assert.match(context.productCategoryPath({ categoryId: " eggs " }).error, /missing, invalid/);
  assert.match(context.productCategoryPath({ categoryId: "brownEggs" }).error, /wrong hierarchy level/);
  assert.match(context.productCategoryPath({ masterCategoryId: "masterDrinks", categoryId: "eggs" }).error, /different hierarchies/);
});

test("legacy snake_case product IDs remain readable", () => {
  normalize();
  const resolved = context.productCategoryPath({
    master_category_id: "masterDairy",
    category_id: "eggs",
    subcategory_id: "brownEggs",
  });
  assert.equal(resolved.error, "");
  assert.equal(context.productCategoryLabel({
    master_category_id: "masterDairy",
    category_id: "eggs",
    subcategory_id: "brownEggs",
  }), "Dairy & Eggs / Egg / Brown Eggs");
});

test("changing master clears selections that do not belong to it", () => {
  normalize();
  const options = context.productFormCategoryOptions("masterDrinks", "eggs", "brownEggs");
  assert.deepEqual([options.masterId, options.categoryId, options.subcategoryId], ["masterDrinks", "", ""]);
});

test("category options contain only children of the selected master", () => {
  normalize();
  const options = context.productFormCategoryOptions("masterDrinks", "", "");
  assert.deepEqual(Array.from(options.categories, (category) => category.id), ["juice"]);
});

test("subcategory options contain only children of the selected category", () => {
  normalize();
  const options = context.productFormCategoryOptions("masterDairy", "eggs", "");
  assert.deepEqual(
    Array.from(options.subcategories, (category) => category.id).sort(),
    ["brownEggs", "whiteEggs"],
  );
  assert.equal(options.subcategories.some((category) => category.id === "skimMilk"), false);
});

test("changing category clears subcategory but preserves the master", () => {
  normalize();
  const options = context.productFormCategoryOptions("masterDairy", "milk", "brownEggs", {
    clearSubcategory: true,
  });
  assert.deepEqual([options.masterId, options.categoryId, options.subcategoryId], ["masterDairy", "milk", ""]);
});

test("save hierarchy validation rejects mismatched parent-child IDs", () => {
  normalize();
  assert.throws(
    () => context.validateProductHierarchy("masterDrinks", "eggs", ""),
    /belongs to this master category/,
  );
  assert.throws(
    () => context.validateProductHierarchy("masterDairy", "eggs", "juiceBox"),
    /belongs to this category/,
  );
});

test("save validation permits valid master/category selection without a subcategory", () => {
  normalize();
  const selected = context.validateProductHierarchy("masterDairy", "eggs", "");
  assert.deepEqual([selected.master.id, selected.category.id, selected.subcategory], ["masterDairy", "eggs", null]);
});

test("inactive category selection is allowed only when preserving the same existing assignment", () => {
  normalize({
    master: { name: "Root", level: "master" },
    category: { name: "Old", level: "category", parentId: "master", status: "inactive" },
  });
  assert.throws(
    () => context.validateProductHierarchy("master", "category", ""),
    /Inactive categories cannot be newly assigned/,
  );
  const existing = context.validateProductHierarchy("master", "category", "", context.categoryState.categories, {
    masterCategoryId: "master",
    categoryId: "category",
  });
  assert.equal(existing.category.id, "category");
});

test("product labels use the same canonical path used to restore the edit form", () => {
  normalize();
  const product = { categoryId: "eggs", subcategoryId: "brownEggs" };
  const path = context.productCategoryPath(product);
  const form = context.productFormCategoryOptions(path.master.id, path.category.id, path.subcategory.id);
  assert.equal(context.productCategoryLabel(product), "Dairy & Eggs / Egg / Brown Eggs");
  assert.deepEqual([form.masterId, form.categoryId, form.subcategoryId], ["masterDairy", "eggs", "brownEggs"]);
});

test("product and inventory filters can share the canonical hierarchy resolution", () => {
  normalize();
  const product = { masterCategoryId: "masterDairy", categoryId: "eggs", subcategoryId: "brownEggs" };
  const path = context.productCategoryPath(product);
  assert.equal(path.master.id, "masterDairy");
  assert.equal(path.category.id, "eggs");
  assert.equal(path.subcategory.id, "brownEggs");
});

test("Inventory & Barcode exposes and filters by canonical subcategory IDs", () => {
  assert.match(html, /id="barcode-subcategory-filter"/);
  const start = html.indexOf("      function barcodeRecords()");
  const end = html.indexOf("      function renderBarcodeManager()", start);
  const source = html.slice(start, end);
  assert.match(source, /productCategoryPath\(record\.product\)/);
  assert.match(source, /path\.subcategory\?\.id === subcategoryId/);
});

test("category deletion guard blocks child categories and product references", () => {
  normalize();
  const product = { categoryId: "eggs" };
  assert.equal(context.categoryCanBeDeleted("masterDairy", context.categoryState.categories, {}), false);
  assert.equal(context.categoryCanBeDeleted("eggs", context.categoryState.categories, { product }), false);
  assert.equal(context.categoryCanBeDeleted("brownEggs", context.categoryState.categories, {}), true);
});

test("product count includes valid canonical references without counting unrelated IDs", () => {
  normalize();
  assert.equal(context.productCount("eggs", {
    first: { categoryId: "eggs" },
    second: { categoryId: "juice" },
  }), 1);
});

test("product filter refresh is separate from form cascading updates", () => {
  const start = html.indexOf("      function updateProductFilters()");
  const end = html.indexOf("      async function barcodeLibrary()", start);
  const source = html.slice(start, end);
  assert.doesNotMatch(source, /updateProductFormCategories/);
  assert.equal((html.match(/#product-master-category"\)\.addEventListener\("change"/g) || []).length, 1);
  assert.equal((html.match(/#product-category"\)\.addEventListener\("change"/g) || []).length, 1);
});

test("product edit writes use partial Firebase update and only show success after the write", () => {
  const start = html.indexOf("      async function saveProduct(event)");
  const end = html.indexOf("      function csvCell(", start);
  const source = html.slice(start, end);
  assert.match(source, /await update\(ref\(database, `products\/\$\{key\}`\), fields\)/);
  assert.ok(source.indexOf("await update(ref(database, `products/${key}`), fields)") < source.indexOf('showCategoryToast(productState.editKey ? "Product updated."'));
  assert.match(source, /catch \(errorValue\)/);
});

test("Realtime Database permits product writes only to authenticated admins", () => {
  assert.equal(databaseRules.rules.products[".read"], databaseRules.rules.categories[".read"]);
  assert.equal(databaseRules.rules.products[".write"], databaseRules.rules.categories[".write"]);
  assert.match(databaseRules.rules.products[".write"], /auth != null/);
  assert.match(databaseRules.rules.products[".write"], /role'\)\.val\(\) === 'admin'/);
});
