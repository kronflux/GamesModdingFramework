import knowledgeSearchOperation from "./search.mjs";
import showOperations from "./show.mjs";

export const knowledgeOperations = [knowledgeSearchOperation, ...showOperations];

export default knowledgeOperations;
