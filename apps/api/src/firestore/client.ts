import { Firestore } from "@google-cloud/firestore";
import { config } from "../config.js";

export const db = new Firestore({
  projectId: config.gcpProjectId || undefined,
  ignoreUndefinedProperties: true,
});
