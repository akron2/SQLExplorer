create table if not exists departments (
  department_id integer primary key,
  department_name varchar(100) not null unique
);

create table if not exists employees (
  employee_id bigserial primary key,
  department_id integer references departments(department_id),
  full_name varchar(120) not null,
  salary numeric(18, 4),
  hired_at timestamp(6) with time zone default current_timestamp,
  notes text
);

insert into departments (department_id, department_name) values
  (10, 'Engineering'),
  (20, 'Analytics')
on conflict (department_id) do nothing;

insert into employees (employee_id, department_id, full_name, salary, notes) values
  (1, 10, 'Alex Demo', 12345.6789, 'Synthetic SQLExplorer test data'),
  (2, 10, 'Taylor Example', 9876.5432, 'Synthetic SQLExplorer test data'),
  (3, 20, 'Sam Sample', null, null)
on conflict (employee_id) do nothing;

select setval(
  pg_get_serial_sequence('employees', 'employee_id'),
  greatest((select coalesce(max(employee_id), 1) from employees), 1)
);

create or replace view employee_details as
select
  e.employee_id,
  e.full_name,
  d.department_name,
  e.salary,
  e.hired_at
from employees e
left join departments d on d.department_id = e.department_id;

create or replace function employee_count(p_department_id integer)
returns bigint
language sql
stable
as $$
  select count(*) from employees where department_id = p_department_id;
$$;
