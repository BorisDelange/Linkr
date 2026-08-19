-- Demo DDL

CREATE TABLE person (
  person_id integer NOT NULL PRIMARY KEY,
  year_of_birth integer NOT NULL
);

CREATE TABLE visit_occurrence (
  visit_occurrence_id integer NOT NULL PRIMARY KEY,
  person_id integer NOT NULL
);
