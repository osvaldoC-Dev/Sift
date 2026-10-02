import decisionsV1Json from './decisions.v1.json';
import researchV1Json from './research.v1.json';

// Project Schemas são DADOS. Quem consome valida com `parseProjectSchema` (@sift/core).
export const researchV1: unknown = researchV1Json;
export const decisionsV1: unknown = decisionsV1Json;
