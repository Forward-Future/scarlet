/** The groups the Skills page draws, in its order. A skill names one in its frontmatter `category:`; any other name is
 * drawn after these, and a skill with none goes under "Other skills". Every skill Scarlet ships names one of these. */
export const SKILL_CATEGORIES = ["Getting started", "Story and pacing", "Sound", "Picture and graphics", "Delivery"] as const;
