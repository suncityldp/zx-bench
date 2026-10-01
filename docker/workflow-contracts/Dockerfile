FROM python:3.12-alpine
COPY yaml /usr/local/lib/python3.12/site-packages/yaml
RUN python3 -c "import yaml; assert yaml.__version__=='6.0.3'; assert yaml.safe_load('name: sample')['name']=='sample'"
