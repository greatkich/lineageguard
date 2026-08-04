{% macro grant_canonical_readers() %}
  {% if execute %}
    {% set relations = [
      'analytics.stg_orders',
      'analytics.customer_revenue',
      'fraud.customer_features'
    ] %}
    {% for relation in relations %}
      {% do run_query('GRANT SELECT ON ' ~ relation ~ ' TO lineageguard_reader') %}
    {% endfor %}
  {% endif %}
{% endmacro %}
