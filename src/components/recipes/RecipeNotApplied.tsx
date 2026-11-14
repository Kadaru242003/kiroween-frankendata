/**
 * The "Not applied" list (Feature 5, Requirement 4.8): every recipe item that
 * could not be mapped, with a plain-text reason. All text is rendered as text.
 */
import type { JSX } from "react";
import type { NotAppliedItem } from "../../core/recipes/types";
import "./Recipes.css";

export function RecipeNotApplied({
  items,
}: {
  items: readonly NotAppliedItem[];
}): JSX.Element | null {
  if (items.length === 0) return null;
  return (
    <section className="recipe-not-applied" aria-label="Recipe items not applied">
      <h3 className="recipe-not-applied__title">Not applied ({items.length})</h3>
      <ul className="recipe-not-applied__list">
        {items.map((item, i) => (
          <li key={`${item.kind}-${i}`} className="recipe-not-applied__item">
            <span className="recipe-not-applied__what">{item.description}</span>
            <span className="recipe-not-applied__why">{item.reason}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

export default RecipeNotApplied;
