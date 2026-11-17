import * as createProducts from "./001-create-products.js";

/** Every migration, in the order they run. To change the schema, add a file and list it here. */
export const migrations = [createProducts];
