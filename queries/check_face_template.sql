-- Replace EMP001 with the employee ID you want to inspect.
SELECT
  e.id AS employee_id,
  e.name,
  e.role,
  ft.registered_at,
  cardinality(ft.descriptor) AS descriptor_values,
  ft.descriptor IS NOT NULL AS face_data_saved
FROM employees AS e
LEFT JOIN face_templates AS ft ON ft.employee_id = e.id
WHERE e.id = 'EMP001';

-- List all saved templates without returning biometric descriptor values.
SELECT employee_id, registered_at, cardinality(descriptor) AS descriptor_values
FROM face_templates
ORDER BY registered_at DESC;
