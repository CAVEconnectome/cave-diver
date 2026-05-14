from flask import Blueprint

from . import (  # noqa: F401
    cell_ids, connectivity, datastacks, decorations, embeddings,
    health, links, plots, recipes, table_rows,
)

api_bp = Blueprint("api", __name__)

# Compose sub-blueprints onto the parent so route definitions live near their domain.
api_bp.register_blueprint(health.bp)
api_bp.register_blueprint(datastacks.bp)
api_bp.register_blueprint(connectivity.bp)
api_bp.register_blueprint(table_rows.bp)
api_bp.register_blueprint(decorations.bp)
api_bp.register_blueprint(links.bp)
api_bp.register_blueprint(plots.bp)
api_bp.register_blueprint(plots.catalog_bp)
api_bp.register_blueprint(cell_ids.bp)
api_bp.register_blueprint(recipes.bp)
api_bp.register_blueprint(embeddings.bp)
