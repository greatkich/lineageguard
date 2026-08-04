{% macro grant_canonical_readers() %}
  {% if execute %}
    {% set ingest_relations = [
      'analytics.stg_orders',
      'analytics.customer_revenue',
      'fraud.customer_features'
    ] %}
    {% for relation in ingest_relations %}
      {% do run_query('GRANT SELECT ON ' ~ relation ~ ' TO lineageguard_ingest_reader') %}
    {% endfor %}
    {% do run_query('GRANT SELECT ON analytics.customer_revenue TO lineageguard_query_reader') %}
  {% endif %}
{% endmacro %}
