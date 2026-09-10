whenever oserror exit failure rollback
whenever sqlerror exit sql.sqlcode rollback
set define off
set echo off

create table departments (
    department_id number(10) primary key,
    department_name varchar2(100 char) not null
);

create table employees (
    employee_id number(10) primary key,
    department_id number(10) references departments(department_id),
    full_name varchar2(120 char) not null,
    salary number(18, 4),
    hired_at timestamp(6),
    notes clob
);

create sequence employee_id_seq start with 100 increment by 1;

insert into departments values (10, 'Engineering');
insert into departments values (20, 'Analytics');
insert into employees values (1, 10, 'Alex Demo', 12345.6789, timestamp '2026-01-15 09:30:00.123456', 'Synthetic test data');
insert into employees values (2, 10, 'Taylor Example', 9876.5432, timestamp '2026-03-20 14:15:00.654321', null);
insert into employees values (3, 20, 'Sam Sample', null, timestamp '2026-06-01 10:00:00.000001', 'Autocomplete and result-grid sample');
commit;

create or replace view employee_details as
select e.employee_id, e.full_name, d.department_name, e.salary, e.hired_at, e.notes
from employees e
left join departments d on d.department_id = e.department_id;

create synonym staff for employees;

create or replace package demo_pkg as
    c_default_bonus constant number := 0.10;
    function annual_salary(p_employee_id in number) return number;
    procedure list_employees(p_department_id in number, p_result out sys_refcursor);
end demo_pkg;
/

create or replace package body demo_pkg as
    function annual_salary(p_employee_id in number) return number is
        l_salary employees.salary%type;
    begin
        select salary into l_salary from employees where employee_id = p_employee_id;
        return l_salary * 12;
    end annual_salary;

    procedure list_employees(p_department_id in number, p_result out sys_refcursor) is
    begin
        open p_result for
            select employee_id, full_name, salary
            from employees
            where department_id = p_department_id
            order by employee_id;
    end list_employees;
end demo_pkg;
/

declare
    l_error_count number;
begin
    select count(*) into l_error_count from user_errors where name = 'DEMO_PKG';
    if l_error_count > 0 then
        raise_application_error(-20001, 'DEMO_PKG compilation failed');
    end if;
end;
/

prompt SQLExplorer sample schema created.
exit success
